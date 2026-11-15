"""Precedence-climbing parser: tokens in, expression tree out."""

from .nodes import Binary, Num, Unary
from .tokens import CalcError, tokenize

# How tightly each binary operator binds; higher binds tighter.
BINDING_POWER = {"+": 10, "-": 10, "*": 20, "/": 20}


class Parser:
    def __init__(self, text):
        self.tokens = tokenize(text)
        self.i = 0

    def peek(self):
        return self.tokens[self.i]

    def advance(self):
        tok = self.tokens[self.i]
        if tok.kind != "end":
            self.i += 1
        return tok

    def parse(self):
        node = self.expression(0)
        tok = self.peek()
        if tok.kind != "end":
            raise CalcError(f"unexpected {tok.text!r} at {tok.pos}")
        return node

    def expression(self, min_power):
        """Parse operators that bind tighter than min_power; equal powers associate left."""
        left = self.operand()
        while True:
            tok = self.peek()
            if tok.kind != "op" or BINDING_POWER[tok.text] <= min_power:
                return left
            self.advance()
            right = self.expression(BINDING_POWER[tok.text])
            left = Binary(tok.text, left, right)

    def operand(self):
        """A number, a parenthesised expression, or a unary minus applied to an operand."""
        tok = self.advance()
        if tok.kind == "num":
            try:
                return Num(float(tok.text))
            except ValueError:
                raise CalcError(f"bad number {tok.text!r} at {tok.pos}") from None
        if tok.kind == "op" and tok.text == "-":
            return Unary("-", self.operand())
        if tok.kind == "lparen":
            node = self.expression(0)
            if self.advance().kind != "rparen":
                raise CalcError(f"missing ')' for '(' at {tok.pos}")
            return node
        if tok.kind == "end":
            raise CalcError("incomplete expression")
        raise CalcError(f"unexpected {tok.text!r} at {tok.pos}")


def parse(text):
    return Parser(text).parse()
