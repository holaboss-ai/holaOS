from .nodes import Binary, Num, Unary
from .tokens import CalcError


def evaluate_node(node):
    if isinstance(node, Num):
        return node.value
    if isinstance(node, Unary):
        return -evaluate_node(node.operand)
    if not isinstance(node, Binary):
        raise CalcError(f"unknown node {node!r}")
    left = evaluate_node(node.left)
    right = evaluate_node(node.right)
    if node.op == "+":
        return left + right
    if node.op == "-":
        return left - right
    if node.op == "*":
        return left * right
    if node.op == "/":
        if right == 0:
            raise CalcError("division by zero")
        return left / right
    raise CalcError(f"unknown operator {node.op!r}")
