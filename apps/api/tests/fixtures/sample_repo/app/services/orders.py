from app.models import Order, execute


def orders_for(user_id):
    return execute("SELECT * FROM orders WHERE user_id = ?", user_id)


def place_order(user_id):
    order = Order()
    validate(order)
    return execute("INSERT INTO orders (user_id) VALUES (?)", user_id)


def validate(order):
    if order is None:
        raise ValueError("no order")
