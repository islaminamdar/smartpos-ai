package info.internext.pos.offline;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Pure deterministic offline-line-v1 arithmetic for schema-1, inclusive-tax AED invoices.
 * This does not authorize issuance, validate signatures, allocate numbers or charge cards.
 * Prices and metadata must come from the verified immutable snapshot, never from the UI.
 */
public final class OfflineCalculator {
    public static final String VERSION = "offline-line-v1";
    public static final long MAX_FILS = 100_000_000L;
    public static final long MAX_QUANTITY_MILLI = 1_000_000L;
    private static final Pattern UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final Pattern DECIMAL_QUANTITY = Pattern.compile("^[0-9]{1,7}(?:\\.[0-9]{1,3})?$");

    private OfflineCalculator() {}

    public enum Unit { piece, pack, kg }

    public static final class InputLine {
        public final String productId;
        public final String name;
        public final Unit unit;
        public final long quantityMilli;
        public final long unitPriceFils;
        public final long taxRateBps;

        public InputLine(String productId, String name, Unit unit, long quantityMilli, long unitPriceFils, long taxRateBps) {
            this.productId = productId;
            this.name = name;
            this.unit = unit;
            this.quantityMilli = quantityMilli;
            this.unitPriceFils = unitPriceFils;
            this.taxRateBps = taxRateBps;
        }
    }

    public static final class Line {
        public final int lineNumber;
        public final String productId;
        public final String name;
        public final Unit unit;
        public final long quantityMilli;
        public final long unitPriceFils;
        public final long taxRateBps;
        public final long grossFils;
        public final long netFils;
        public final long taxFils;

        private Line(int lineNumber, InputLine input, long grossFils, long taxFils) {
            this.lineNumber = lineNumber;
            this.productId = input.productId;
            this.name = input.name;
            this.unit = input.unit;
            this.quantityMilli = input.quantityMilli;
            this.unitPriceFils = input.unitPriceFils;
            this.taxRateBps = input.taxRateBps;
            this.grossFils = grossFils;
            this.netFils = Math.subtractExact(grossFils, taxFils);
            this.taxFils = taxFils;
        }
    }

    public static final class Payment {
        public final String method;
        public final long amountFils;
        private Payment(String method, long amountFils) {
            this.method = method;
            this.amountFils = amountFils;
        }
    }

    public static final class Calculation {
        public final List<Line> lines;
        public final List<Payment> payments;
        public final long grossFils;
        public final long netFils;
        public final long taxFils;
        public final long cashTenderedFils;
        public final long changeFils;
        /** Issuance must require and validate buyer details when true. */
        public final boolean requiresBuyerDetails;

        private Calculation(List<Line> lines, List<Payment> payments, long gross, long tax, long cashTendered, long change) {
            this.lines = Collections.unmodifiableList(new ArrayList<>(lines));
            this.payments = Collections.unmodifiableList(new ArrayList<>(payments));
            this.grossFils = gross;
            this.taxFils = tax;
            this.netFils = Math.subtractExact(gross, tax);
            this.cashTenderedFils = cashTendered;
            this.changeFils = change;
            this.requiresBuyerDetails = gross > 1_000_000L;
        }
    }

    /** Parse display quantity exactly: no floating point, exponent, sign, or silent rounding. */
    public static long parseQuantityMilli(String quantity, Unit unit) {
        if (quantity == null || unit == null || !DECIMAL_QUANTITY.matcher(quantity).matches()) {
            throw invalid("Invalid quantity text.");
        }
        int point = quantity.indexOf('.');
        String whole = point < 0 ? quantity : quantity.substring(0, point);
        String fraction = point < 0 ? "" : quantity.substring(point + 1);
        long milli = Math.addExact(Math.multiplyExact(Long.parseLong(whole), 1000),
            Long.parseLong((fraction + "000").substring(0, 3)));
        validateQuantity(milli, unit);
        return milli;
    }

    /**
     * Cash is physically tendered; card is an externally recorded payment, never a charge.
     * Applied cash is gross minus card; excess cash is change. Card cannot exceed gross.
     */
    public static Calculation calculate(String version, boolean taxInclusive, List<InputLine> inputs,
                                        long cashTenderedFils, long recordedCardFils) {
        if (!VERSION.equals(version) || !taxInclusive) throw invalid("Unsupported calculation profile.");
        if (inputs == null || inputs.isEmpty() || inputs.size() > 200) throw invalid("Invalid basket size.");
        bounded(cashTenderedFils, 0, MAX_FILS, "Cash tendered");
        bounded(recordedCardFils, 0, MAX_FILS, "Recorded card");
        List<Line> lines = new ArrayList<>();
        Set<String> products = new HashSet<>();
        long gross = 0, tax = 0;
        for (InputLine input : inputs) {
            if (input == null || input.productId == null || !UUID.matcher(input.productId).matches()
                || !products.add(input.productId)) throw invalid("Invalid or duplicate product identifier.");
            if (input.name == null || input.name.isEmpty() || input.name.length() > 240
                || !input.name.equals(input.name.trim())) throw invalid("Invalid product name.");
            validateQuantity(input.quantityMilli, input.unit);
            bounded(input.unitPriceFils, 0, MAX_FILS, "Unit price");
            bounded(input.taxRateBps, 0, 10_000, "Tax rate");
            // Bounds before multiplication keep intermediates <= 10^14, also safe in JS.
            long lineGross = halfUp(Math.multiplyExact(input.unitPriceFils, input.quantityMilli), 1000);
            bounded(lineGross, 0, MAX_FILS, "Line total");
            long lineTax = halfUp(Math.multiplyExact(lineGross, input.taxRateBps), 10_000 + input.taxRateBps);
            gross = Math.addExact(gross, lineGross);
            tax = Math.addExact(tax, lineTax);
            bounded(gross, 0, MAX_FILS, "Invoice total");
            lines.add(new Line(lines.size() + 1, input, lineGross, lineTax));
        }
        if (gross == 0) throw invalid("Invoice total must be positive.");
        if (recordedCardFils > gross) throw invalid("Card exceeds invoice total.");
        long cashApplied = Math.subtractExact(gross, recordedCardFils);
        if (cashTenderedFils < cashApplied || (cashApplied == 0 && cashTenderedFils != 0)) {
            throw invalid("Cash does not reconcile.");
        }
        List<Payment> payments = new ArrayList<>();
        if (cashApplied > 0) payments.add(new Payment("cash", cashApplied));
        if (recordedCardFils > 0) payments.add(new Payment("card", recordedCardFils));
        return new Calculation(lines, payments, gross, tax, cashTenderedFils,
            Math.subtractExact(cashTenderedFils, cashApplied));
    }

    private static long halfUp(long numerator, long denominator) {
        long quotient = numerator / denominator;
        long remainder = numerator % denominator;
        return remainder >= (denominator + 1) / 2 ? Math.addExact(quotient, 1) : quotient;
    }

    private static void validateQuantity(long quantity, Unit unit) {
        if (unit == null) throw invalid("Invalid unit.");
        bounded(quantity, 1, MAX_QUANTITY_MILLI, "Quantity");
        if (unit != Unit.kg && quantity % 1000 != 0) throw invalid("Pieces and packs require whole quantities.");
    }

    private static void bounded(long value, long min, long max, String field) {
        if (value < min || value > max) throw invalid(field + " is outside the supported range.");
    }

    private static IllegalArgumentException invalid(String message) {
        return new IllegalArgumentException(message);
    }
}
