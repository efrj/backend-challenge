import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "../errors/domain-errors";

export interface MoneyProps {
  amount: string; // decimal string, e.g.: "25.00"
  currency: string; // ISO-4217, e.g.: "BRL"
}

const VALID_DECIMAL_REGEX = /^\d+(\.\d{1,2})?$/;
const VALID_CURRENCY_REGEX = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (!props || typeof props !== "object") {
      throw new InvalidMoneyError("Money props must be an object");
    }

    const { amount, currency } = props;

    if (typeof amount !== "string" || amount.length === 0) {
      throw new InvalidMoneyError("Money amount must be a non-empty decimal string");
    }

    if (typeof currency !== "string" || !VALID_CURRENCY_REGEX.test(currency)) {
      throw new InvalidMoneyError(
        `Invalid ISO-4217 currency code: '${String(currency)}'`,
      );
    }

    if (amount.trim() !== amount) {
      throw new InvalidMoneyError(`Money amount must not contain whitespace: '${amount}'`);
    }

    if (
      amount.startsWith("-") ||
      amount.startsWith("+") ||
      /[eE]/.test(amount) ||
      amount === "NaN" ||
      amount === "Infinity" ||
      amount === "-Infinity"
    ) {
      throw new InvalidMoneyError(`Invalid money amount '${amount}'`);
    }

    if (!VALID_DECIMAL_REGEX.test(amount)) {
      throw new InvalidMoneyError(
        `Money amount '${amount}' must be a valid non-negative decimal with at most 2 decimal places`,
      );
    }

    const decimalValue = new Decimal(amount);
    if (!decimalValue.isFinite() || decimalValue.isNaN() || decimalValue.isNegative()) {
      throw new InvalidMoneyError(`Money amount '${amount}' is not a valid finite non-negative amount`);
    }

    return new Money(decimalValue.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN), currency);
  }

  static rehydrate(props: MoneyProps): Money {
    if (!props || typeof props.amount !== "string" || typeof props.currency !== "string") {
      throw new InvalidMoneyError("Invalid persisted Money state");
    }
    const decimalValue = new Decimal(props.amount);
    return new Money(decimalValue.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN), props.currency);
  }

  static zero(currency: string): Money {
    if (typeof currency !== "string" || !VALID_CURRENCY_REGEX.test(currency)) {
      throw new InvalidMoneyError(`Invalid ISO-4217 currency code: '${String(currency)}'`);
    }
    return new Money(new Decimal("0.00"), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(
      this.value.plus(other.value).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN),
      this.currency,
    );
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(
      this.value.minus(other.value).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN),
      this.currency,
    );
  }

  negate(): Money {
    if (this.value.isZero()) {
      return new Money(new Decimal("0.00"), this.currency);
    }
    return new Money(this.value.negated(), this.currency);
  }

  abs(): Money {
    return new Money(this.value.abs(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value. greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  equals(other: Money): boolean {
    if (!(other instanceof Money)) {
      return false;
    }
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  get amount(): string {
    return this.value.toFixed(2);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

