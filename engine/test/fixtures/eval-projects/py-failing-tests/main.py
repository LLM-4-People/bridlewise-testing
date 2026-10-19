# py-failing-tests: a failure-prone fixture where the test suite fails.

def divide(a, b):
    # Bug: does not guard against division by zero.
    return a / b


def parse_int(value):
    # Bug: raises ValueError on empty string instead of returning None.
    return int(value)
