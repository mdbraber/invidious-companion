import { assertEquals, assertRejects } from "./deps.ts";
import { isBotVerdict, openWithBotRetry } from "../lib/sabr/session.ts";

const bot = () =>
    new Error(
        "abc: playability LOGIN_REQUIRED: Sign in to confirm you’re not a bot",
    );

Deno.test("isBotVerdict - only the 'not a bot' LOGIN_REQUIRED", () => {
    assertEquals(isBotVerdict(bot()), true);
    assertEquals(
        isBotVerdict(
            new Error(
                "abc: playability LOGIN_REQUIRED: Sign in to confirm your age",
            ),
        ),
        false,
    );
    assertEquals(
        isBotVerdict(new Error("abc: playability UNPLAYABLE: not a bot")),
        false,
    );
    assertEquals(isBotVerdict(undefined), false);
});

Deno.test("openWithBotRetry - asks once more after a bot verdict", async () => {
    let calls = 0;
    const s = await openWithBotRetry("abc", "TEST", () => {
        calls++;
        return calls === 1 ? Promise.reject(bot()) : Promise.resolve("ok");
    });
    assertEquals(s, "ok");
    assertEquals(calls, 2);
});

Deno.test("openWithBotRetry - at most once, and not for other errors", async () => {
    let calls = 0;
    await assertRejects(() =>
        openWithBotRetry("abc", "TEST", () => {
            calls++;
            return Promise.reject(bot());
        })
    );
    assertEquals(calls, 2);

    calls = 0;
    await assertRejects(() =>
        openWithBotRetry("abc", "TEST", () => {
            calls++;
            return Promise.reject(
                new Error("abc: playability UNPLAYABLE: gone"),
            );
        })
    );
    assertEquals(calls, 1);
});
