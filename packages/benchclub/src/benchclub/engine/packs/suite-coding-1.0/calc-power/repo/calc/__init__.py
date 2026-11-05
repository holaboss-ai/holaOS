"""A small calculator for arithmetic expressions."""

from .evaluate import evaluate_node
from .parser import parse
from .tokens import CalcError

__all__ = ["CalcError", "evaluate"]


def evaluate(text):
    """Evaluate an expression such as "2 * (3 + 4)" and return a float."""
    return evaluate_node(parse(text))
