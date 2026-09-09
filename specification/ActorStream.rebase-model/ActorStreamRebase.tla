---------------------- MODULE ActorStreamRebase ----------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
VARIABLES native, beforeClosed, proof, observed, body, phase, canceled,
          snapshot, acknowledged, published, executions, remainderId, textId, outcome
vars == <<native,beforeClosed,proof,observed,body,phase,canceled,snapshot,
          acknowledged,published,executions,remainderId,textId,outcome>>
Init == /\ native \in BOOLEAN /\ beforeClosed = FALSE /\ proof = FALSE
 /\ observed \in BOOLEAN /\ body = "B" /\ phase = "open" /\ canceled = FALSE
 /\ snapshot = <<>> /\ acknowledged = FALSE /\ published = <<>>
 /\ executions = 0 /\ remainderId = "segment1" /\ textId = "text2" /\ outcome = "open"
Close == /\ phase = "open" /\ ~canceled /\ beforeClosed' = TRUE
 /\ UNCHANGED <<native,proof,observed,body,phase,canceled,snapshot,acknowledged,published,executions,remainderId,textId,outcome>>
Prove == /\ phase = "open" /\ ~canceled /\ proof' = native
 /\ UNCHANGED <<native,beforeClosed,observed,body,phase,canceled,snapshot,acknowledged,published,executions,remainderId,textId,outcome>>
Plan == /\ phase = "open" /\ ~canceled /\ beforeClosed /\ proof
 /\ phase' = "planned"
 /\ snapshot' = (IF observed THEN <<[message |-> remainderId, text |-> textId, index |-> 0, body |-> body]>> ELSE <<>>)
 /\ UNCHANGED <<native,beforeClosed,proof,observed,body,canceled,acknowledged,published,executions,remainderId,textId,outcome>>
Ack == /\ phase = "planned" /\ ~canceled /\ phase' = "acked" /\ acknowledged' = TRUE
 /\ UNCHANGED <<native,beforeClosed,proof,observed,body,canceled,snapshot,published,executions,remainderId,textId,outcome>>
Publish == /\ phase = "acked" /\ ~canceled /\ phase' = "published" /\ published' = snapshot
 /\ UNCHANGED <<native,beforeClosed,proof,observed,body,canceled,snapshot,acknowledged,executions,remainderId,textId,outcome>>
Execute == /\ phase = "published" /\ ~canceled /\ phase' = "running" /\ executions' = 1
 /\ UNCHANGED <<native,beforeClosed,proof,observed,body,canceled,snapshot,acknowledged,published,remainderId,textId,outcome>>
Finish(t) == /\ phase \in {"open","running"} /\ ~canceled /\ outcome' = t /\ phase' = "done"
 /\ UNCHANGED <<native,beforeClosed,proof,observed,body,canceled,snapshot,acknowledged,published,executions,remainderId,textId>>
Cancel == /\ ~canceled /\ canceled' = TRUE
 /\ UNCHANGED <<native,beforeClosed,proof,observed,body,phase,snapshot,acknowledged,published,executions,remainderId,textId,outcome>>
Next == Close \/ Prove \/ Plan \/ Ack \/ Publish \/ Execute \/
 (\E t \in {"stop","toolUse","error","aborted","length","deferred"}: Finish(t)) \/ Cancel
Spec == Init /\ [][Next]_vars
AfterCommitOnly == published # <<>> => acknowledged
StableIdentity == \A p \in {published[i]: i \in DOMAIN published}: p.text = "text2" /\ p.message = "segment1" /\ p.index = 0 /\ p.body = "B"
SnapshotPrewrite == acknowledged /\ observed => Len(snapshot) = 1
NoUnobservedStart == ~observed => published = <<>>
NoOrdinarySkip == acknowledged => native /\ proof /\ beforeClosed
NoReplay == executions <= 1
AllOutcomesKeepPrefix == outcome # "open" /\ acknowledged => snapshot # <<>> \/ ~observed
ImmediateRebaseEnabled == phase = "acked" /\ ~canceled => ENABLED Publish
======================================================================
