# Pricing policy

- Prices are kept in integer cents. Never use floats for money.
- A customer can enter one discount code at checkout. Codes are case-insensitive
  and surrounding whitespace is ignored, so ` save10 ` and `SAVE10` are the same code.
- A percentage code applies once, to the order subtotal. The discount is rounded
  half up to the cent: 598.5 cents of discount becomes 599 cents.
- A fixed-amount code takes that amount off the subtotal, but never takes the
  total below 0.
- An unknown code raises `UnknownCode`.
