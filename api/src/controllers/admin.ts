import { createGQLAdminDB, getGQLAdminDB } from "db/schema/GQLAdmin";
import express from "express";
import { JWT_EXPIRES } from "lib/config";
import { hashPassword, verifyPassword } from "utils/hash";
import { createToken } from "utils/jwt";
import {
  createRefreshToken,
  deleteRefreshToken,
  verifyRefreshToken,
} from "utils/refresh-token";
import { v4 as uuidv4 } from "uuid";

export const logout = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  try {
    const { uid } = res.locals;
    const { refreshToken } = req.body;

    await deleteRefreshToken(uid, refreshToken);

    res.locals.data = {
      success: true,
    };
    return next("router");
  } catch (err) {
    return next(err);
  }
};

export const refresh = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  try {
    const { refreshToken } = req.body;

    const id = await verifyRefreshToken(refreshToken);

    const user = await getGQLAdminDB({ where: { objectId: id } });

    const token = createToken({
      sub: id,
      admin: true,
      user: {
        uid: id,
        email: user.email,
      },
    });

    res.locals.data = {
      uid: id,
      idToken: token,
      refreshToken,
      expires: parseInt(JWT_EXPIRES),
    };
    return next("router");
  } catch (err) {
    return next(err);
  }
};

export const create = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  try {
    const { email, password } = req.body;

    const id = uuidv4();
    await createGQLAdminDB({
      objectId: id,
      email,
      passwordHash: hashPassword(password),
    });

    const token = createToken({
      sub: id,
      admin: true,
      user: {
        uid: id,
        email,
      },
    });

    const refreshToken = await createRefreshToken(id);

    res.locals.data = {
      uid: id,
      idToken: token,
      refreshToken,
      expires: parseInt(JWT_EXPIRES),
    };
    return next("router");
  } catch (err: any) {
    if (err.message === "Validation error")
      err.message =
        "This email address is already associated with an existing user.";
    return next(err);
  }
};

export const login = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  try {
    const { email, password } = req.body;

    const user = await getGQLAdminDB({ where: { email } });
    const id = user.objectId;

    if (!verifyPassword(password, user.passwordHash))
      throw new Error("Your password is invalid.");

    const token = createToken({
      sub: id,
      admin: true,
      user: {
        uid: id,
        email: user.email,
      },
    });
    const refreshToken = await createRefreshToken(id);

    res.locals.data = {
      uid: id,
      idToken: token,
      refreshToken,
      expires: parseInt(JWT_EXPIRES),
    };
    return next("router");
  } catch (err: any) {
    if (err.message === "Cannot read property 'dataValues' of null")
      err.message = "The email is not associated with an existing user.";
    return next(err);
  }
};