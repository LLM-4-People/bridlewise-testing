import unittest

from main import divide, parse_int


class TestSuite(unittest.TestCase):
    def test_divide_by_zero(self):
        # This test FAILS: divide(5, 0) raises ZeroDivisionError instead of returning None.
        self.assertIsNone(divide(5, 0))

    def test_parse_empty(self):
        # This test FAILS: parse_int("") raises ValueError instead of returning None.
        self.assertIsNone(parse_int(""))

    def test_divide_normal(self):
        self.assertEqual(divide(10, 2), 5)
