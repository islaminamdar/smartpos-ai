package info.internext.pos.counter;

import org.junit.Test;
import static org.junit.Assert.*;

public class CounterOriginTest {
    @Test public void allowsOnlyTheFixedHttpsOrigin() {
        assertTrue(CounterOrigin.allowed(CounterOrigin.HOME));
        assertTrue(CounterOrigin.allowed("https://pos.internext.info:443/counter?x=1#receipt"));
        assertTrue(CounterOrigin.allowed("https://POS.INTERNEXT.INFO/api/pos/session"));
    }

    @Test public void rejectsHostConfusionAndLocalOrExecutableSchemes() {
        for (String url : new String[] { null, "", "//pos.internext.info/counter",
                "http://pos.internext.info/counter", "https://pos.internext.info:8443/",
                "https://pos.internext.info.attacker.example/", "https://attacker.example/",
                "https://attacker@pos.internext.info/", "https://pos.internext.info@attacker.example/",
                "https://pos.internext.info./", "https://pos.internext.info\\@attacker.example/",
                "file:///data/data/private", "content://private", "javascript:alert(1)",
                "data:text/html,hi", "intent://pos.internext.info", "https://pos%2einternext.info/" }) {
            assertFalse("Must block: " + url, CounterOrigin.allowed(url));
        }
    }
}
