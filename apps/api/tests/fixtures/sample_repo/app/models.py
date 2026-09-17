class Base:
    pass


class User(Base):
    __tablename__ = "users"

    @classmethod
    def load(cls, user_id):
        return execute("SELECT * FROM users WHERE id = ?", user_id)


class Order(Base):
    __tablename__ = "orders"


def execute(sql, *params):
    return None
