"""Technology-stack detection from languages, dependencies, and marker files."""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any

from archon.ingest.manifests import Dependency

# dependency name (lowercase) -> (category, display name)
_KNOWN: dict[str, tuple[str, str]] = {
    # web frameworks
    "fastapi": ("framework", "FastAPI"),
    "django": ("framework", "Django"),
    "flask": ("framework", "Flask"),
    "starlette": ("framework", "Starlette"),
    "express": ("framework", "Express"),
    "next": ("framework", "Next.js"),
    "react": ("framework", "React"),
    "vue": ("framework", "Vue"),
    "@angular/core": ("framework", "Angular"),
    "svelte": ("framework", "Svelte"),
    "@nestjs/core": ("framework", "NestJS"),
    "koa": ("framework", "Koa"),
    "fastify": ("framework", "Fastify"),
    "hono": ("framework", "Hono"),
    "nuxt": ("framework", "Nuxt"),
    "github.com/gin-gonic/gin": ("framework", "Gin"),
    "github.com/labstack/echo/v4": ("framework", "Echo"),
    "github.com/gofiber/fiber/v2": ("framework", "Fiber"),
    "github.com/go-chi/chi/v5": ("framework", "Chi"),
    "org.springframework.boot:spring-boot-starter-web": ("framework", "Spring Boot"),
    "org.springframework.boot:spring-boot-starter": ("framework", "Spring Boot"),
    "actix-web": ("framework", "Actix"),
    "axum": ("framework", "Axum"),
    "rails": ("framework", "Rails"),
    "laravel/framework": ("framework", "Laravel"),
    # databases / ORMs
    "sqlalchemy": ("database", "SQLAlchemy"),
    "psycopg2": ("database", "PostgreSQL"),
    "psycopg": ("database", "PostgreSQL"),
    "asyncpg": ("database", "PostgreSQL"),
    "pg": ("database", "PostgreSQL"),
    "mysql2": ("database", "MySQL"),
    "pymysql": ("database", "MySQL"),
    "mysqlclient": ("database", "MySQL"),
    "sqlite3": ("database", "SQLite"),
    "better-sqlite3": ("database", "SQLite"),
    "prisma": ("database", "Prisma"),
    "@prisma/client": ("database", "Prisma"),
    "typeorm": ("database", "TypeORM"),
    "sequelize": ("database", "Sequelize"),
    "mongoose": ("database", "MongoDB"),
    "pymongo": ("database", "MongoDB"),
    "motor": ("database", "MongoDB"),
    "redis": ("database", "Redis"),
    "ioredis": ("database", "Redis"),
    "drizzle-orm": ("database", "Drizzle"),
    "knex": ("database", "Knex"),
    "gorm.io/gorm": ("database", "GORM"),
    "github.com/lib/pq": ("database", "PostgreSQL"),
    "github.com/jackc/pgx/v5": ("database", "PostgreSQL"),
    "org.springframework.boot:spring-boot-starter-data-jpa": ("database", "JPA"),
    "org.hibernate:hibernate-core": ("database", "Hibernate"),
    "alembic": ("database", "Alembic"),
    # messaging / infra
    "celery": ("infra", "Celery"),
    "kafka-python": ("infra", "Kafka"),
    "kafkajs": ("infra", "Kafka"),
    "bullmq": ("infra", "BullMQ"),
    "pika": ("infra", "RabbitMQ"),
    "amqplib": ("infra", "RabbitMQ"),
    "boto3": ("infra", "AWS"),
    "aws-sdk": ("infra", "AWS"),
    "@aws-sdk/client-s3": ("infra", "AWS"),
    "firebase": ("infra", "Firebase"),
    "firebase-admin": ("infra", "Firebase"),
    "@supabase/supabase-js": ("infra", "Supabase"),
    # auth
    "passport": ("auth", "Passport"),
    "jsonwebtoken": ("auth", "JWT"),
    "pyjwt": ("auth", "JWT"),
    "python-jose": ("auth", "JWT"),
    "next-auth": ("auth", "NextAuth"),
    "@clerk/nextjs": ("auth", "Clerk"),
    "@auth0/auth0-react": ("auth", "Auth0"),
    "org.springframework.boot:spring-boot-starter-security": ("auth", "Spring Security"),
    "bcrypt": ("auth", "bcrypt"),
    "passlib": ("auth", "passlib"),
    # AI
    "openai": ("ai", "OpenAI"),
    "anthropic": ("ai", "Anthropic"),
    "google-genai": ("ai", "Gemini"),
    "langchain": ("ai", "LangChain"),
    "@langchain/core": ("ai", "LangChain"),
    "transformers": ("ai", "Transformers"),
    "torch": ("ai", "PyTorch"),
    "tensorflow": ("ai", "TensorFlow"),
    # testing
    "pytest": ("testing", "pytest"),
    "jest": ("testing", "Jest"),
    "vitest": ("testing", "Vitest"),
    "mocha": ("testing", "Mocha"),
    "cypress": ("testing", "Cypress"),
    "@playwright/test": ("testing", "Playwright"),
    "junit:junit": ("testing", "JUnit"),
    "org.junit.jupiter:junit-jupiter": ("testing", "JUnit"),
    "github.com/stretchr/testify": ("testing", "Testify"),
    # build / tooling
    "typescript": ("tooling", "TypeScript"),
    "vite": ("tooling", "Vite"),
    "webpack": ("tooling", "Webpack"),
    "tailwindcss": ("tooling", "Tailwind CSS"),
    "eslint": ("tooling", "ESLint"),
    "ruff": ("tooling", "Ruff"),
    "black": ("tooling", "Black"),
    "mypy": ("tooling", "mypy"),
    "poetry": ("tooling", "Poetry"),
}

_MARKERS: dict[str, tuple[str, str]] = {
    "Dockerfile": ("infra", "Docker"),
    "docker-compose.yml": ("infra", "Docker Compose"),
    "docker-compose.yaml": ("infra", "Docker Compose"),
    ".github/workflows": ("ci", "GitHub Actions"),
    ".gitlab-ci.yml": ("ci", "GitLab CI"),
    "Jenkinsfile": ("ci", "Jenkins"),
    "terraform": ("infra", "Terraform"),
    "k8s": ("infra", "Kubernetes"),
    "kubernetes": ("infra", "Kubernetes"),
    "helm": ("infra", "Helm"),
    "serverless.yml": ("infra", "Serverless"),
    "vercel.json": ("infra", "Vercel"),
    "netlify.toml": ("infra", "Netlify"),
    "Makefile": ("tooling", "Make"),
    "tsconfig.json": ("tooling", "TypeScript"),
    "package-lock.json": ("package_manager", "npm"),
    "pnpm-lock.yaml": ("package_manager", "pnpm"),
    "yarn.lock": ("package_manager", "yarn"),
    "bun.lockb": ("package_manager", "bun"),
    "poetry.lock": ("package_manager", "poetry"),
    "uv.lock": ("package_manager", "uv"),
    "Pipfile.lock": ("package_manager", "pipenv"),
    "requirements.txt": ("package_manager", "pip"),
    "go.sum": ("package_manager", "go modules"),
    "pom.xml": ("package_manager", "Maven"),
    "build.gradle": ("package_manager", "Gradle"),
    "build.gradle.kts": ("package_manager", "Gradle"),
    "Cargo.lock": ("package_manager", "Cargo"),
}

_LANG_LABEL = {
    "python": "Python",
    "javascript": "JavaScript",
    "typescript": "TypeScript",
    "tsx": "TypeScript",
    "go": "Go",
    "java": "Java",
    "sql": "SQL",
    "prisma": "Prisma",
}


def detect_stack(root: Path, language_counts: Counter[str], deps: list[Dependency]) -> dict[str, Any]:
    langs: Counter[str] = Counter()
    for lang, n in language_counts.items():
        langs[_LANG_LABEL.get(lang, lang)] += n
    total = sum(langs.values()) or 1
    languages = [{"name": k, "files": v, "share": round(v / total, 3)} for k, v in langs.most_common()]

    found: dict[str, set[str]] = {}
    for d in deps:
        hit = _KNOWN.get(d.name.lower())
        if hit:
            found.setdefault(hit[0], set()).add(hit[1])
    for marker, (cat, label) in _MARKERS.items():
        if (root / marker).exists():
            found.setdefault(cat, set()).add(label)

    ecosystems = sorted({d.ecosystem for d in deps})
    return {
        "languages": languages,
        "primary_language": languages[0]["name"] if languages else "",
        "frameworks": sorted(found.get("framework", set())),
        "databases": sorted(found.get("database", set())),
        "auth": sorted(found.get("auth", set())),
        "infra": sorted(found.get("infra", set())),
        "ci": sorted(found.get("ci", set())),
        "ai": sorted(found.get("ai", set())),
        "testing": sorted(found.get("testing", set())),
        "tooling": sorted(found.get("tooling", set())),
        "package_managers": sorted(found.get("package_manager", set())),
        "ecosystems": ecosystems,
        "dependency_count": len({(d.ecosystem, d.name) for d in deps}),
    }
