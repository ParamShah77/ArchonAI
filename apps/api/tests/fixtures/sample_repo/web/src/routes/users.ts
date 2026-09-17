import { Router } from "express";
import { query } from "../db";

export const router = Router();

export class UserRepo {
  async byId(id: string) {
    return query("SELECT * FROM users WHERE id = $1", [id]);
  }
}

router.get("/users/:id", async (req, res) => {
  const repo = new UserRepo();
  res.json(await repo.byId(req.params.id));
});
