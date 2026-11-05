"""Failures a person can act on: one plain sentence, then the next step."""


class HolaError(Exception):
    def __init__(self, code, message, next_step=None, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.next_step = next_step
        self.details = details or {}

    def to_json(self):
        out = {"code": self.code, "message": self.message, "next_step": self.next_step}
        if self.details:
            out["details"] = self.details
        return out
