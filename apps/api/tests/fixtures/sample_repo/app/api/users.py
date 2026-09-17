from fastapi import APIRouter

from app.models import User
from app.services.orders import orders_for

router = APIRouter(prefix="/users")


@router.get("/{user_id}")
def get_user(user_id: int):
    user = User.load(user_id)
    return {"user": user, "orders": orders_for(user_id)}
