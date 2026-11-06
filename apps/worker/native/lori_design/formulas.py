"""A small, safe formula evaluator so generated workbooks carry real cached values.

Spreadsheet readers that do not recalculate (LibreOffice when rendering a preview,
pandas, most viewers) show whatever value is stored beside a formula. Writers like
XlsxWriter store 0 unless told otherwise, which makes every total look empty. The
kit evaluates the formulas it writes with this module and stores the result.

Supported: numbers, percentages, + - * / ^ & comparisons, parentheses, cell and range
references (A1, $A$1, Sheet!A1, 'Sheet name'!A1:B9), and SUM, AVERAGE, MIN, MAX,
COUNT, ABS, ROUND and IF. Anything else evaluates to None
(the caller then stores 0 and a recalculation fills it in).
"""
from __future__ import annotations

import math
import re
from typing import Any, Callable

_TOKEN = re.compile(
    r"""\s*(?:
        (?P<num>\d+(?:\.\d+)?(?:[eE][+-]?\d+)?%?)
      | (?P<str>"(?:[^"]|"")*")
      | (?P<ref>(?:(?:'[^']+'|[A-Za-z_][\w.]*)!)?\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)
      | (?P<fn>[A-Za-z][A-Za-z0-9.]*)\(
      | (?P<op><=|>=|<>|[-+*/^(),<>=&])
    )""",
    re.VERBOSE,
)
_ADDRESS = re.compile(r"^\$?([A-Z]{1,3})\$?(\d+)$")


class Unsupported(Exception):
    pass


def column_index(letters: str) -> int:
    index = 0
    for ch in letters:
        index = index * 26 + (ord(ch) - 64)
    return index - 1


class Formulas:
    """Evaluate formulas against a store of {(sheet, row, col): value} (zero-based row/col)."""

    def __init__(self, values: dict[tuple[str, int, int], Any]):
        self.values = values

    def evaluate(self, formula: str, sheet: str) -> Any:
        try:
            parser = _Parser(formula.lstrip("="), sheet, self.values)
            result = parser.parse()
            if isinstance(result, list):
                raise Unsupported
            if isinstance(result, float) and (math.isnan(result) or math.isinf(result)):
                return None
            return result
        except (Unsupported, ZeroDivisionError, ValueError, KeyError, TypeError, OverflowError):
            return None


class _Parser:
    def __init__(self, text: str, sheet: str, values: dict):
        self.sheet, self.values = sheet, values
        self.tokens = self._tokenize(text)
        self.i = 0

    @staticmethod
    def _tokenize(text: str):
        tokens, pos = [], 0
        while pos < len(text.rstrip()):
            match = _TOKEN.match(text, pos)
            if not match or match.end() == pos:
                raise Unsupported
            kind = match.lastgroup
            tokens.append((kind, match.group(kind)))
            pos = match.end()
        return tokens

    def peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else (None, None)

    def take(self):
        token = self.peek()
        self.i += 1
        return token

    def expect(self, op: str) -> None:
        if self.take() != ("op", op):
            raise Unsupported

    def parse(self):
        value = self.comparison()
        if self.i != len(self.tokens):
            raise Unsupported
        return value

    # precedence: comparison < concat < additive < multiplicative < power < unary
    def comparison(self):
        left = self.concat()
        while self.peek()[0] == "op" and self.peek()[1] in ("=", "<>", "<", ">", "<=", ">="):
            op = self.take()[1]
            right = self.concat()
            left = {"=": left == right, "<>": left != right, "<": left < right, ">": left > right,
                    "<=": left <= right, ">=": left >= right}[op]
        return left

    def concat(self):
        left = self.additive()
        while self.peek() == ("op", "&"):
            self.take()
            left = f"{_text(left)}{_text(self.additive())}"
        return left

    def additive(self):
        left = self.multiplicative()
        while self.peek()[0] == "op" and self.peek()[1] in "+-" and len(self.peek()[1]) == 1:
            op = self.take()[1]
            right = self.multiplicative()
            left = _number(left) + _number(right) if op == "+" else _number(left) - _number(right)
        return left

    def multiplicative(self):
        left = self.power()
        while self.peek()[0] == "op" and self.peek()[1] in ("*", "/"):
            op = self.take()[1]
            right = self.power()
            left = _number(left) * _number(right) if op == "*" else _number(left) / _number(right)
        return left

    def power(self):
        base = self.unary()
        if self.peek() == ("op", "^"):
            self.take()
            return _number(base) ** _number(self.power())
        return base

    def unary(self):
        if self.peek() == ("op", "-"):
            self.take()
            return -_number(self.unary())
        if self.peek() == ("op", "+"):
            self.take()
            return self.unary()
        return self.primary()

    def primary(self):
        kind, text = self.take()
        if kind == "num":
            return float(text[:-1]) / 100 if text.endswith("%") else float(text)
        if kind == "str":
            return text[1:-1].replace('""', '"')
        if kind == "ref":
            return self.reference(text)
        if kind == "op" and text == "(":
            value = self.comparison()
            self.expect(")")
            return value
        if kind == "fn":
            args = []
            if self.peek() != ("op", ")"):
                args.append(self.comparison())
                while self.peek() == ("op", ","):
                    self.take()
                    args.append(self.comparison())
            self.expect(")")
            return self.call(text.upper(), args)
        raise Unsupported

    def reference(self, text: str):
        sheet = self.sheet
        if "!" in text:
            name, text = text.rsplit("!", 1)
            sheet = name[1:-1].replace("''", "'") if name.startswith("'") else name
        parts = text.split(":")
        cells = []
        for part in parts:
            match = _ADDRESS.match(part)
            if not match:
                raise Unsupported
            cells.append((int(match.group(2)) - 1, column_index(match.group(1))))
        if len(cells) == 1:
            row, col = cells[0]
            return self._cell(sheet, row, col, strict=True)
        (r1, c1), (r2, c2) = cells
        return [self._cell(sheet, r, c, strict=False)
                for r in range(min(r1, r2), max(r1, r2) + 1) for c in range(min(c1, c2), max(c1, c2) + 1)]

    def _cell(self, sheet: str, row: int, col: int, strict: bool):
        key = (sheet, row, col)
        if key not in self.values:
            if strict:
                raise Unsupported  # not written yet: the real value is unknown
            return None
        return self.values[key]

    def call(self, name: str, args: list):
        flat = [v for a in args for v in (a if isinstance(a, list) else [a])]
        numbers = [float(v) for v in flat if isinstance(v, (int, float)) and not isinstance(v, bool)]
        if name == "SUM":
            return sum(numbers)
        if name == "AVERAGE":
            return sum(numbers) / len(numbers)
        if name == "MIN":
            return min(numbers) if numbers else 0.0
        if name == "MAX":
            return max(numbers) if numbers else 0.0
        if name == "COUNT":
            return float(len(numbers))
        if name == "ABS":
            return abs(_number(args[0]))
        if name == "ROUND":
            digits = int(_number(args[1])) if len(args) > 1 else 0
            factor = 10 ** digits
            return math.floor(_number(args[0]) * factor + 0.5) / factor if _number(args[0]) >= 0 else -math.floor(-_number(args[0]) * factor + 0.5) / factor
        if name == "IF":
            return args[1] if args[0] else (args[2] if len(args) > 2 else False)
        raise Unsupported


def _number(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    raise Unsupported


def _text(value: Any) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return "" if value is None else str(value)
