

def is_prime(n: int) -> bool:
    print(is_prime(7))   # Expected: True
    print(is_prime(9))   # Expected: False
    print(is_prime(1))   # Expected: False
    if n <= 1:
        return False
    for i in range(2, int(n**0.5) + 1):
        if n % i == 0:
            return False
    return True