from __future__ import annotations

from archon.graph.model import EdgeKind, NodeKind
from archon.ingest.extractors import extract_file


def _kinds(fx, kind):
    return [n for n in fx.nodes if n.kind == kind]


def test_python_extracts_symbols_routes_and_tables():
    src = b'''
from fastapi import APIRouter
from .db import get_session

router = APIRouter(prefix="/items")

class Base: ...

class Item(Base):
    __tablename__ = "items"
    def save(self):
        return run("INSERT INTO items VALUES (1)")

@router.get("/{id}")
async def read_item(id: int):
    return helper(id)

def helper(x):
    return x
'''
    fx = extract_file("app/items.py", "python", src)
    assert {n.name for n in _kinds(fx, NodeKind.CLASS)} == {"Base", "Item"}
    assert {n.name for n in _kinds(fx, NodeKind.FUNCTION)} == {"read_item", "helper"}
    assert [n.qualified_name for n in _kinds(fx, NodeKind.METHOD)] == ["app/items.py::Item.save"]
    assert [n.name for n in _kinds(fx, NodeKind.ENDPOINT)] == ["GET /items/{id}"]
    assert [n.name for n in _kinds(fx, NodeKind.TABLE)] == ["items"]
    assert {i["module"] for i in fx.imports} == {"fastapi", "db"}
    assert any(c.get("table") == "items" for c in fx.calls)
    assert {"class": _kinds(fx, NodeKind.CLASS)[1].id, "base": "Base"} in fx.bases
    read_item = next(n for n in fx.nodes if n.name == "read_item")
    assert read_item.meta["async"] is True
    assert any(e.kind == EdgeKind.EXPOSES for e in fx.edges)


def test_typescript_express_and_classes():
    src = b"""
import express from "express";
import { db } from "../db";
const router = express.Router();
export class Svc extends BaseSvc { async find(id: string) { return db.query("SELECT * FROM users"); } }
router.post("/users", async (req, res) => { res.json(await new Svc().find("1")); });
export const list = () => 1;
"""
    fx = extract_file("src/routes/users.ts", "typescript", src)
    assert [n.name for n in _kinds(fx, NodeKind.CLASS)] == ["Svc"]
    assert [n.name for n in _kinds(fx, NodeKind.METHOD)] == ["find"]
    assert [n.name for n in _kinds(fx, NodeKind.ENDPOINT)] == ["POST /users"]
    assert {n.name for n in _kinds(fx, NodeKind.FUNCTION)} == {"POST /users handler", "list"}
    assert {i["module"] for i in fx.imports} == {"express", "../db"}
    assert any(c.get("table") == "users" for c in fx.calls)


def test_next_app_route_handlers_become_endpoints():
    src = b"export async function GET(req: Request) { return Response.json({}); }\nexport async function POST() {}\n"
    fx = extract_file("src/app/api/items/route.ts", "typescript", src)
    assert {n.name for n in _kinds(fx, NodeKind.ENDPOINT)} == {"GET /api/items", "POST /api/items"}


def test_go_methods_attach_to_struct_and_routes():
    src = b"""
package main
import "github.com/gin-gonic/gin"
type Server struct{}
func (s *Server) Users(c *gin.Context) {}
func main() { r := gin.Default(); r.GET("/users", s.Users) }
"""
    fx = extract_file("main.go", "go", src)
    server = next(n for n in fx.nodes if n.name == "Server")
    users = next(n for n in fx.nodes if n.name == "Users")
    assert users.kind == NodeKind.METHOD
    assert any(e.kind == EdgeKind.CONTAINS and e.source == server.id and e.target == users.id for e in fx.edges)
    assert [n.name for n in _kinds(fx, NodeKind.ENDPOINT)] == ["GET /users"]
    assert fx.imports[0]["module"] == "github.com/gin-gonic/gin"


def test_java_spring_controller_and_entity():
    src = b"""
package com.x;
import com.x.repo.UserRepository;
@Entity @Table(name = "app_users")
class User {}
@RestController
@RequestMapping("/api/users")
public class UserController extends Base implements Health {
    @GetMapping("/{id}") public User get(Long id) { return repo.findById(id); }
    @PostMapping public User create() { return null; }
}
"""
    fx = extract_file("src/main/java/com/x/UserController.java", "java", src)
    assert {n.name for n in _kinds(fx, NodeKind.ENDPOINT)} == {"GET /api/users/{id}", "POST /api/users"}
    assert [n.name for n in _kinds(fx, NodeKind.TABLE)] == ["app_users"]
    assert {b["base"] for b in fx.bases} == {"Base", "Health"}
    assert any(b.get("kind") == "implements" for b in fx.bases)


def test_sql_tables_and_foreign_keys():
    src = b"CREATE TABLE users (id INT PRIMARY KEY);\nCREATE TABLE orders (id INT, user_id INT REFERENCES users(id));"
    fx = extract_file("schema.sql", "sql", src)
    tables = {n.name: n for n in _kinds(fx, NodeKind.TABLE)}
    assert set(tables) == {"users", "orders"}
    assert tables["orders"].meta["references"] == ["users"]
    assert tables["users"].meta["columns"] == ["id"]


def test_prisma_models():
    src = b"model User {\n  id Int @id\n  posts Post[]\n}\nmodel Post {\n  id Int @id\n  author User\n}\n"
    fx = extract_file("prisma/schema.prisma", "prisma", src)
    tables = {n.name: n for n in _kinds(fx, NodeKind.TABLE)}
    assert set(tables) == {"user", "post"}
    assert tables["post"].meta["references"] == ["user"]


def test_syntax_errors_do_not_crash():
    fx = extract_file("bad.py", "python", b"def broken(:\n  class X(\nimport os\n")
    assert fx is not None and fx.nodes[0].kind == NodeKind.FILE
