import { makeExecutableSchema } from "@graphql-tools/schema";
import cors from "cors";
import createBuckets from "db/create-buckets";
import createTables from "db/create-tables";
import database from "db/postgres";
import pubsub from "db/pubsub";
import { createDateResolver, createDateSchema } from "db/schema/Date";
import express from "express";
import fileUpload from "express-fileupload";
import { graphqlHTTP } from "express-graphql";
import fs from "fs";
import { execute, subscribe } from "graphql";
import { useServer } from "graphql-ws/lib/use/ws";
import { merge } from "lodash";
import authMiddleware, { checkJWT } from "middlewares/auth";
import path from "path";
import adminRouter, { adminSchema } from "routes/admin";
import authRouter from "routes/auth";
import storageRouter from "routes/storage";
import { Op } from "sequelize";
import { withFilter } from "utils/with-filter";
import { WebSocketServer } from "ws";
import url from "url";

let exportedResolvers: any = {};
let exportedSchema: any = "";
let mergedResolvers: any = {};
try {
  exportedResolvers = require(path.resolve(
    __dirname,
    "../config/resolvers.js"
  ));

  Object.keys(exportedResolvers).forEach((resolver) => {
    mergedResolvers = merge(
      exportedResolvers[resolver](database, Op, withFilter, pubsub),
      mergedResolvers
    );
  });

  exportedSchema = fs
    .readFileSync(path.resolve(__dirname, "../config/schema.graphql"))
    .toString();
} catch (err: any) {
  console.error("No GraphQL config files.");
}

createTables();
createBuckets();

const dateSchema = createDateSchema();
const dateResolver = createDateResolver();

/* Resolvers */
const resolvers = merge(mergedResolvers, dateResolver);

/* Schemas */
const typeDefs = [exportedSchema, dateSchema];

const schema = makeExecutableSchema({ typeDefs, resolvers });

const app = express();

app.use(
  fileUpload({
    limits: {
      fileSize: 50 * 1024 * 1024 * 1024, // 50 MB max file(s) size
    },
  })
);

app.set("json spaces", 2);
app.use(cors({ origin: "*", methods: "GET,POST,HEAD,OPTIONS,DELETE" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get(
  "/warm",
  async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    return res.status(200).json({
      success: true,
    });
  }
);

app.use("/auth", authRouter);
app.use("/storage", storageRouter);
app.use("/admin", adminRouter);

app.use(
  "/graphql",
  authMiddleware,
  graphqlHTTP({
    schema,
    graphiql: false,
  })
);

app.use(
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (["/graphql"].includes(req.path)) return next();
    if (!res.locals.data) throw new Error("The requested URL was not found.");
    res.statusCode = 200;
    if (res.locals.data === true) return res.end();
    res.set("Content-Type", "application/json");
    return res.json(res.locals.data);
  }
);
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    res.set("Content-Type", "application/json");
    res.statusCode = 400;
    console.error(err.message);
    return res.json({
      error: {
        message: err.message,
      },
    });
  }
);

const PORT = 4000;

const server = app.listen(PORT, () => {
  console.log(`🚀 REST API running on http://localhost:${PORT}`);
  console.log(`🚀 GraphQL Server running on http://localhost:${PORT}/graphql`);
  console.log(`🚀 WebSockets listening on ws://localhost:${PORT}/graphql`);
  const wsServer = new WebSocketServer({
    noServer: true,
  });
  const adminWsServer = new WebSocketServer({
    noServer: true,
  });

  // delegate upgrade requests to relevant destinations
  server.on("upgrade", (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;

    if (pathname === "/graphql") {
      return wsServer.handleUpgrade(request, socket, head, (client) => {
        wsServer.emit("connection", client, request);
      });
    }

    if (pathname === "/admin/graphql") {
      return adminWsServer.handleUpgrade(request, socket, head, (client) => {
        adminWsServer.emit("connection", client, request);
      });
    }

    return socket.destroy();
  });

  useServer(
    {
      schema,
      execute,
      subscribe,
      onConnect: async (ctx) => {
        const connectionParams: any = ctx.connectionParams?.headers;
        const headers = ctx.extra.request.headers;

        if (!headers.authorization && !connectionParams) return false;

        const token = (
          headers.authorization || connectionParams["Authorization"]
        )?.split("Bearer ")[1];

        if (token === process.env.SECRET_KEY) {
          return true;
        }

        const isTokenValid = await checkJWT(token);

        if (!isTokenValid) return false;
      },
    },
    wsServer
  );

  useServer(
    {
      schema: adminSchema,
      execute,
      subscribe,
      onConnect: async (ctx) => {
        const connectionParams: any = ctx.connectionParams?.headers;
        const headers = ctx.extra.request.headers;

        if (!headers.authorization && !connectionParams) return false;

        const token = (
          headers.authorization || connectionParams["Authorization"]
        )?.split("Bearer ")[1];

        if (token === process.env.SECRET_KEY) {
          return true;
        }

        const isTokenValid = await checkJWT(token, true);

        if (!isTokenValid) return false;
      },
    },
    adminWsServer
  );
});
