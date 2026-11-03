---- MODULE RegistrationWait ----
\* Sources:
\*   src/client.mjs sha256:0e962ecd93aa095796bfe5dd14b888124d3b71e96b518718dc2df0cb8bc6930b
\*   src/extension.mjs sha256:9483faf8a4e9bdfb2e242fa9b3a20437f2816553b4fba0d180189a6265b06caa

\* Status events are not replayed, so a waiter that starts after the client became
\* terminal hears nothing. It must read the state on entry instead of timing out.
EXTENDS Naturals
CONSTANT CheckOnEntry
VARIABLES client, waiter

vars == <<client, waiter>>

Init == client = "connecting" /\ waiter = "none"

\* A terminal event reaches only a waiter already listening.
Terminal == client = "connecting" /\ client' = "rejected"
  /\ waiter' = IF waiter = "listening" THEN "failed" ELSE waiter
Register == client = "connecting" /\ client' = "connected"
  /\ waiter' = IF waiter = "listening" THEN "ready" ELSE waiter

StartWait == waiter = "none" /\ UNCHANGED client
  /\ waiter' = CASE client = "connected" -> "ready"
                 [] CheckOnEntry /\ client = "rejected" -> "failed"
                 [] OTHER -> "listening"

Done == UNCHANGED vars
Next == Terminal \/ Register \/ StartWait \/ Done
Spec == Init /\ [][Next]_vars

\* Listening is only legal while an event can still arrive.
NoMissedTerminal == waiter = "listening" => client = "connecting"
====
