from fastapi import FastAPI

from app.api.users import router as users_router
from app.services.orders import place_order

app = FastAPI()
app.include_router(users_router)


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/orders")
def create_order(user_id: int):
    return place_order(user_id)
