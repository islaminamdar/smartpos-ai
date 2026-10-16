package info.internext.pos.offline;

import static org.junit.Assert.*;
import static info.internext.pos.offline.OfflineCalculator.*;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class OfflineCalculatorTest {
    private static final String ID = "00000000-0000-4000-8000-000000000001";
    private static InputLine line(Unit unit, long qty, long price, long rate) {
        return new InputLine(ID, "Synthetic", unit, qty, price, rate);
    }
    private static Calculation sale(InputLine line, long cash, long card) {
        return calculate(VERSION, true, Collections.singletonList(line), cash, card);
    }
    private static void rejected(Runnable run) {
        assertThrows(IllegalArgumentException.class, run::run);
    }
    @Test public void sharedGoldenVectorsMatchEveryFinancialField() throws Exception {
        try (InputStream stream = getClass().getResourceAsStream("/offline-line-v1.json")) {
            assertNotNull("Shared web/native fixture missing", stream);
            JSONObject fixture = new JSONObject(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
            assertEquals(VERSION, fixture.getString("version"));
            JSONArray vectors = fixture.getJSONArray("vectors");
            assertTrue(vectors.length() >= 12);
            for (int i = 0; i < vectors.length(); i++) {
                JSONObject vector = vectors.getJSONObject(i), input = vector.getJSONObject("input"), expected = vector.getJSONObject("expected");
                List<InputLine> lines = new ArrayList<>();
                JSONArray jsonLines = input.getJSONArray("lines");
                for (int j = 0; j < jsonLines.length(); j++) {
                    JSONObject row = jsonLines.getJSONObject(j);
                    lines.add(new InputLine(row.getString("productId"), row.getString("name"), Unit.valueOf(row.getString("unit")),
                        row.getLong("quantityMilli"), row.getLong("unitPriceFils"), row.getLong("taxRateBps")));
                }
                Calculation actual = calculate(input.getString("calculationVersion"), input.getBoolean("taxInclusive"), lines,
                    input.getLong("cashTenderedFils"), input.getLong("recordedCardFils"));
                assertJsonSame(vector.getString("name"), expected, asJson(actual));
            }
        }
    }
    private static void assertJsonSame(String path, Object expected, Object actual) throws org.json.JSONException {
        if (expected instanceof JSONObject) {
            assertTrue(path, actual instanceof JSONObject);
            JSONObject left = (JSONObject) expected, right = (JSONObject) actual;
            assertEquals(path, left.length(), right.length());
            java.util.Iterator<String> keys = left.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                assertJsonSame(path + "." + key, left.get(key), right.get(key));
            }
        } else if (expected instanceof JSONArray) {
            assertTrue(path, actual instanceof JSONArray);
            JSONArray left = (JSONArray) expected, right = (JSONArray) actual;
            assertEquals(path, left.length(), right.length());
            for (int i = 0; i < left.length(); i++) assertJsonSame(path + "[" + i + "]", left.get(i), right.get(i));
        } else if (expected instanceof Number) {
            assertTrue(path, actual instanceof Number);
            assertEquals(path, ((Number) expected).longValue(), ((Number) actual).longValue());
        } else assertEquals(path, expected, actual);
    }
    private static JSONObject asJson(Calculation result) throws org.json.JSONException {
        JSONArray lines = new JSONArray(), payments = new JSONArray();
        for (Line line : result.lines) lines.put(new JSONObject().put("lineNumber", line.lineNumber)
            .put("productId", line.productId).put("name", line.name).put("unit", line.unit.name())
            .put("quantityMilli", line.quantityMilli).put("unitPriceFils", line.unitPriceFils).put("taxRateBps", line.taxRateBps)
            .put("grossFils", line.grossFils).put("netFils", line.netFils).put("taxFils", line.taxFils));
        for (Payment payment : result.payments) payments.put(new JSONObject().put("method", payment.method).put("amountFils", payment.amountFils));
        return new JSONObject().put("lines", lines).put("payments", payments)
            .put("totals", new JSONObject().put("grossFils", result.grossFils).put("netFils", result.netFils).put("taxFils", result.taxFils))
            .put("cashTenderedFils", result.cashTenderedFils).put("changeFils", result.changeFils)
            .put("requiresBuyerDetails", result.requiresBuyerDetails);
    }
    @Test public void parsesQuantitiesWithoutFloatingPointOrRounding() {
        assertEquals(1, parseQuantityMilli("0.001", Unit.kg));
        assertEquals(125, parseQuantityMilli("0.125", Unit.kg));
        assertEquals(1000, parseQuantityMilli("1.000", Unit.piece));
        assertEquals(1_000_000, parseQuantityMilli("1000", Unit.pack));
        for (String invalid : Arrays.asList("", " 1", "1 ", ".5", "1.", "1e3", "NaN", "-1", "+1", "0", "0.0001", "1000.001", "9999999999999999999999999")) {
            rejected(() -> parseQuantityMilli(invalid, Unit.kg));
        }
        rejected(() -> parseQuantityMilli("0.5", Unit.piece));
        rejected(() -> parseQuantityMilli("1.001", Unit.pack));
        rejected(() -> parseQuantityMilli(null, Unit.kg));
        rejected(() -> parseQuantityMilli("1", null));
    }
    @Test public void rejectsUnsupportedProfilesAndEmptyOrOversizedBasket() {
        List<InputLine> valid = Collections.singletonList(line(Unit.piece,1000,100,500));
        rejected(() -> calculate("other",true,valid,100,0));
        rejected(() -> calculate(VERSION,false,valid,100,0));
        rejected(() -> calculate(VERSION,true,null,100,0));
        rejected(() -> calculate(VERSION,true,Collections.emptyList(),100,0));
        rejected(() -> calculate(VERSION,true,Collections.nCopies(201,valid.get(0)),100,0));
    }
    @Test public void rejectsOverflowAndUnsupportedFinancialRangesBeforeArithmetic() {
        for (long invalid : new long[]{-1, Long.MIN_VALUE, Long.MAX_VALUE, 100_000_001}) {
            rejected(() -> sale(line(Unit.piece,1000,invalid,500),100,0));
            rejected(() -> sale(line(Unit.piece,1000,100,500),invalid,0));
            rejected(() -> sale(line(Unit.piece,1000,100,500),0,invalid));
        }
        for (long invalid : new long[]{0,-1,1_000_001,Long.MAX_VALUE})
            rejected(() -> sale(line(Unit.kg,invalid,100,500),100,0));
        for (long invalid : new long[]{-1,10_001,Long.MAX_VALUE})
            rejected(() -> sale(line(Unit.piece,1000,100,invalid),100,0));
        rejected(() -> sale(line(Unit.piece,1_000_000,100_000_000,500),100_000_000,0));
        InputLine a = line(Unit.piece,1000,60_000_000,500);
        InputLine b = new InputLine("00000000-0000-4000-8000-000000000002","Synthetic",Unit.piece,1000,60_000_000,500);
        rejected(() -> calculate(VERSION,true,Arrays.asList(a,b),100_000_000,0));
    }
    @Test public void rejectsAmbiguousProductLines() {
        InputLine valid = line(Unit.piece,1000,100,500);
        rejected(() -> calculate(VERSION,true,Arrays.asList(valid,valid),200,0));
        rejected(() -> sale(new InputLine("BAD","Synthetic",Unit.piece,1000,100,500),100,0));
        rejected(() -> sale(new InputLine(ID," Synthetic ",Unit.piece,1000,100,500),100,0));
        rejected(() -> sale(line(null,1000,100,500),100,0));
        rejected(() -> sale(line(Unit.pack,1500,100,500),150,0));
        rejected(() -> sale(null,100,0));
    }
    @Test public void rejectsUnderpaymentCardOverpaymentAndCashOnCardOnlyInvoice() {
        InputLine item = line(Unit.piece,1000,100,500);
        rejected(() -> sale(item,99,0));
        rejected(() -> sale(item,49,50));
        rejected(() -> sale(item,0,101));
        rejected(() -> sale(item,1,100));
        rejected(() -> sale(line(Unit.piece,1000,0,500),0,0));
    }
    @Test public void resultCollectionsCannotBeMutated() {
        Calculation result = sale(line(Unit.piece,1000,100,500),100,0);
        assertThrows(UnsupportedOperationException.class, () -> result.lines.clear());
        assertThrows(UnsupportedOperationException.class, () -> result.payments.clear());
    }
}
