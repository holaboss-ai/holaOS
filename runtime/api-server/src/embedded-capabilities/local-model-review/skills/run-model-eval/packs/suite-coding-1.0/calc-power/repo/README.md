# calc

`calc.evaluate(text)` evaluates an arithmetic expression and returns a float.

- Numbers: `12`, `3.5`, `.5`
- Binary operators: `+` and `-` (lowest), then `*` and `/`. Operators of equal
  precedence associate to the left: `1 - 2 - 3` is `-4`.
- Unary minus: `-3`, `2 - -1`, `-(1 + 2)`
- Parentheses group.

Errors raise `calc.CalcError`: an unexpected character, an incomplete expression
such as `2 +`, an unbalanced parenthesis, and division by zero.

The tokenizer is in `calc/tokens.py`, the parser in `calc/parser.py`, and the
evaluator in `calc/evaluate.py`.
