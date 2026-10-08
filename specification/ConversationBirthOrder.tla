----------------------- MODULE ConversationBirthOrder -----------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
CONSTANTS UseBirth, UseSequence, ScopeBranch, KeepFirst, KeepFailedText,
          RecoverSequence, KeepRebase, PersistStamp
Rows == {"P", "A", "Q", "B", "C"}
Text == {"A", "B", "C"}
Source == <<"P", "A", "Q", "B", "C">>
Zero == [r \in Rows |-> 0]
Max(s) == IF s = {} THEN 0 ELSE CHOOSE x \in s: \A y \in s: x >= y
VARIABLES next, births, persisted, canonical, live, arrivals, branch,
          restarted, replaced, rebased, conflict, failed, announcedFailure, clock, original
vars == <<next,births,persisted,canonical,live,arrivals,branch,
          restarted,replaced,rebased,conflict,failed,announcedFailure,clock,original>>
Init == /\ next = 1 /\ births = Zero /\ persisted = Zero /\ canonical = {}
        /\ live = {} /\ arrivals = <<>> /\ branch = Rows /\ clock = 0
        /\ restarted = FALSE /\ replaced = FALSE /\ rebased = FALSE
        /\ conflict = FALSE /\ failed = {} /\ announcedFailure = {} /\ original = Zero
Birth == /\ next <= 5 /\ (next = 5 => restarted \/ replaced)
         /\ LET r == Source[next] IN
            /\ births' = [births EXCEPT ![r] = clock + 1]
            /\ original' = [original EXCEPT ![r] = clock + 1]
            /\ persisted' = IF r \in Text THEN persisted ELSE [persisted EXCEPT ![r] = clock + 1]
            /\ canonical' = IF r \in Text THEN canonical ELSE canonical \cup {r}
         /\ next' = next + 1 /\ clock' = clock + 1
         /\ UNCHANGED <<live,arrivals,branch,restarted,replaced,rebased,conflict,failed,announcedFailure>>
Publish(r) == /\ births[r] > 0 /\ r \in branch /\ r \notin live
              /\ live' = live \cup {r} /\ arrivals' = Append(arrivals,r)
              /\ UNCHANGED <<next,births,persisted,canonical,branch,restarted,replaced,rebased,conflict,failed,announcedFailure,clock,original>>
Commit(r) == /\ r \in Text \cap branch /\ births[r] > 0 /\ r \notin canonical \cup failed
             /\ canonical' = canonical \cup {r}
             /\ persisted' = [persisted EXCEPT ![r] = IF PersistStamp THEN births[r] ELSE 0]
             /\ UNCHANGED <<next,births,live,arrivals,branch,restarted,replaced,rebased,conflict,failed,announcedFailure,clock,original>>
FailCommit(r) == /\ r \in Text \cap live /\ r \notin canonical \cup failed
                 /\ failed' = failed \cup {r} /\ announcedFailure' = announcedFailure \cup {r}
                 /\ live' = IF KeepFailedText THEN live ELSE live \ {r}
                 /\ UNCHANGED <<next,births,persisted,canonical,arrivals,branch,restarted,replaced,rebased,conflict,clock,original>>
Restart == /\ next = 5 /\ ~restarted /\ {"P","A","Q","B"} \subseteq canonical
           /\ restarted' = TRUE
           /\ clock' = IF RecoverSequence THEN Max({persisted[r]: r \in canonical \cap branch}) ELSE 0
           /\ UNCHANGED <<next,births,persisted,canonical,live,arrivals,branch,replaced,rebased,conflict,failed,announcedFailure,original>>
Fork == /\ next = 5 /\ ~replaced /\ {"P","A","Q","B"} \subseteq canonical
        /\ replaced' = TRUE /\ branch' = {"P","A","C"} /\ live' = live \cap {"P","A"}
        /\ clock' = IF RecoverSequence THEN Max({persisted[r]: r \in {"P","A"}}) ELSE 0
        /\ UNCHANGED <<next,births,persisted,canonical,arrivals,restarted,rebased,conflict,failed,announcedFailure,original>>
Rebase == /\ births["A"] > 0 /\ ~rebased /\ rebased' = TRUE
          /\ births' = IF KeepRebase THEN births ELSE [births EXCEPT !["A"] = 0]
          /\ UNCHANGED <<next,persisted,canonical,live,arrivals,branch,restarted,replaced,conflict,failed,announcedFailure,clock,original>>
ConflictingMetadata == /\ births["A"] > 0 /\ ~conflict /\ conflict' = TRUE
                       /\ births' = IF KeepFirst THEN births ELSE [births EXCEPT !["A"] = 9]
                       /\ UNCHANGED <<next,persisted,canonical,live,arrivals,branch,restarted,replaced,rebased,failed,announcedFailure,clock,original>>
Next == Birth \/ Restart \/ Fork \/ Rebase \/ ConflictingMetadata \/
        (\E r \in Rows: Publish(r) \/ Commit(r) \/ FailCommit(r))
Time(r) == IF UseBirth \/ r \notin Text THEN 1 ELSE 0
Arrival(r) == IF r \in live THEN CHOOSE i \in 1..Len(arrivals): arrivals[i] = r ELSE 0
Tie(r, stamps) == IF UseSequence THEN stamps[r] ELSE Arrival(r)
Before(a,b,stamps) == Time(a) < Time(b) \/ (Time(a) = Time(b) /\ Tie(a,stamps) < Tie(b,stamps))
Cold == canonical \cap (IF ScopeBranch THEN branch ELSE Rows)
SourceIndex(r) == CHOOSE i \in 1..Len(Source): Source[i] = r
LiveChronology == \A a,b \in live: SourceIndex(a) < SourceIndex(b) => Before(a,b,births)
ColdChronology == \A a,b \in Cold: SourceIndex(a) < SourceIndex(b) => Before(a,b,persisted)
SameBirth == \A r \in Rows: original[r] = births[r]
ExactRecovery == \A r \in canonical: persisted[r] = original[r]
BranchScoped == Cold \subseteq branch
FailureVisible == (failed \cap branch) \subseteq live /\ failed = announcedFailure
Spec == Init /\ [][Next]_vars
=============================================================================
