import { describe, expect, it } from "bun:test";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from "../../src/domain/errors/domain-errors";
import { Money } from "../../src/domain/money/money";

describe("Money (Domain Value Object)", () => {
  it("creates Money with fixed scale of 2 decimal places and serializes to MoneyProps", () => {
    const m1 = Money.from({ amount: "25.00", currency: "BRL" });
    expect(m1.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(m1.toString()).toBe("25.00 BRL");
    expect(m1.isPositive()).toBe(true);
    expect(m1.isZero()).toBe(false);
    expect(m1.isNegative()).toBe(false);

    const m2 = Money.from({ amount: "100", currency: "BRL" });
    expect(m2.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });

    const m3 = Money.from({ amount: "7.5", currency: "BRL" });
    expect(m3.toJSON()).toEqual({ amount: "7.50", currency: "BRL" });

    const zero = Money.zero("BRL");
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
    expect(zero.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
  });

  it("is immutable and returns new instances on arithmetic operations", () => {
    const a = Money.from({ amount: "100.00", currency: "BRL" });
    const b = Money.from({ amount: "25.55", currency: "BRL" });

    const sum = a.add(b);
    const diff = a.subtract(b);
    const neg = b.negate();

    expect(a.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
    expect(b.toJSON()).toEqual({ amount: "25.55", currency: "BRL" });
    expect(sum.toJSON()).toEqual({ amount: "125.55", currency: "BRL" });
    expect(diff.toJSON()).toEqual({ amount: "74.45", currency: "BRL" });
    expect(neg.toJSON()).toEqual({ amount: "-25.55", currency: "BRL" });
    expect(neg.isNegative()).toBe(true);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("avoids IEEE-754 floating point drift (e.g. 0.10 + 0.20 === 0.30)", () => {
    const a = Money.from({ amount: "0.10", currency: "BRL" });
    const b = Money.from({ amount: "0.20", currency: "BRL" });
    const expected = Money.from({ amount: "0.30", currency: "BRL" });

    expect(a.add(b).equals(expected)).toBe(true);
    expect(a.add(b).toJSON().amount).toBe("0.30");
  });

  it("compares Money instances accurately", () => {
    const m20 = Money.from({ amount: "20.00", currency: "BRL" });
    const m80 = Money.from({ amount: "80.00", currency: "BRL" });
    const m80Copy = Money.from({ amount: "80.00", currency: "BRL" });

    expect(m20.isLessThan(m80)).toBe(true);
    expect(m80.isLessThan(m20)).toBe(false);
    expect(m80.isLessThan(m80Copy)).toBe(false);
    expect(m80.equals(m80Copy)).toBe(true);
    expect(m20.equals(m80)).toBe(false);
  });

  it("rejects invalid inputs: NaN, Infinity, scientific notation, empty string, >2 decimal places, negative inputs, invalid currency", () => {
    const invalidAmounts = [
      "",
      "   ",
      " 10.00",
      "10.00 ",
      "NaN",
      "Infinity",
      "-Infinity",
      "1e2",
      "1E-2",
      "25.000",
      "25.123",
      "-10.00",
      "-0.01",
      "+10.00",
      "abc",
      "10,00",
      "10..00",
      ".50",
      "10.",
    ];

    for (const amount of invalidAmounts) {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow(
        InvalidMoneyError,
      );
    }

    const invalidCurrencies = ["", "br", "brl", "BRLL", "123", "B$L"];
    for (const currency of invalidCurrencies) {
      expect(() => Money.from({ amount: "10.00", currency })).toThrow(
        InvalidMoneyError,
      );
      expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
    }
  });

  it("throws CurrencyMismatchError when operating across different currencies", () => {
    const brl = Money.from({ amount: "50.00", currency: "BRL" });
    const usd = Money.from({ amount: "50.00", currency: "USD" });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
  });
});

