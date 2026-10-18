-------------------- MODULE NotificationLifecycle --------------------
EXTENDS Naturals, FiniteSets, Sequences
CONSTANTS Actors, Root, MaxEpisodes
VARIABLES episode, busy, pending, quiet, closed, needs, idleNotices, needNotices, background, owner, pendingUser, jobOwner, pendingOwner
vars == <<episode, busy, pending, quiet, closed, needs, idleNotices, needNotices, background, owner, pendingUser, jobOwner, pendingOwner>>
VARIABLE observation
SnapshotInitial == [phase |-> "pick", n |-> 0, entry |-> "supplied", current |-> 0,
                    outer |-> [index |-> 0, version |-> 0], previous |-> [index |-> 0, version |-> 0],
                    used |-> [index |-> 0, version |-> 0], reads |-> 0, oldReads |-> 0,
                    expected |-> "unobserved", result |-> "unobserved"]
Init == /\ observation = SnapshotInitial /\ episode = 0 /\ busy = {} /\ pending = {} /\ quiet = 0
        /\ closed = TRUE /\ needs = FALSE /\ idleNotices = {} /\ needNotices = {} /\ background = FALSE /\ owner = "user" /\ pendingUser = FALSE /\ jobOwner = "none" /\ pendingOwner = "none"
\* Actors includes root, child, and grandchild. Retained idle/inactive actors
\* are absent from busy. Live inference, tools, and starting handoffs are busy.
Start(a, source) ==
    /\ a \in Actors /\ a \notin busy
    /\ (~closed \/ episode < MaxEpisodes)
    /\ episode' = (IF closed THEN episode + 1 ELSE episode)
    /\ closed' = FALSE /\ busy' = busy \cup {a} /\ quiet' = 0
    /\ needs' = (IF closed THEN FALSE ELSE needs)
    /\ owner' = (IF closed THEN IF pendingUser THEN "user" ELSE IF pendingOwner # "none" THEN pendingOwner ELSE IF source = "cron" THEN "cron" ELSE owner ELSE owner)
    /\ pendingUser' = IF closed THEN FALSE ELSE pendingUser
    /\ pendingOwner' = IF closed THEN "none" ELSE pendingOwner
    /\ UNCHANGED <<pending, idleNotices, needNotices, background, jobOwner>>
Settle(a) == /\ a \in busy /\ busy' = busy \ {a} /\ quiet' = 0
             /\ UNCHANGED <<episode, pending, closed, needs, idleNotices, needNotices, background, owner, pendingUser, jobOwner, pendingOwner>>
Queue(a) == /\ a \in Actors /\ pending' = pending \cup {a}
            /\ UNCHANGED <<episode, busy, quiet, closed, needs, idleNotices, needNotices, background, owner, pendingUser, jobOwner, pendingOwner>>
\* Queue reconciliation is not a permanent empty-queue success prerequisite.
Drain(a) == /\ a \in pending /\ pending' = pending \ {a}
            /\ UNCHANGED <<episode, busy, quiet, closed, needs, idleNotices, needNotices, background, owner, pendingUser, jobOwner, pendingOwner>>
Tick == /\ ~closed /\ busy = {} /\ quiet < 2 /\ quiet' = quiet + 1
        /\ UNCHANGED <<episode, busy, pending, closed, needs, idleNotices, needNotices, background, owner, pendingUser, jobOwner, pendingOwner>>
NeedsYou(a) == /\ a = Root /\ ~closed /\ ~needs /\ episode \notin needNotices
               /\ needs' = TRUE /\ needNotices' = needNotices \cup {episode}
               /\ UNCHANGED <<episode, busy, pending, quiet, closed, idleNotices, background, owner, pendingUser, jobOwner, pendingOwner>>
Resolve == /\ needs /\ needs' = FALSE
           /\ UNCHANGED <<episode, busy, pending, quiet, closed, idleNotices, needNotices, background, owner, pendingUser, jobOwner, pendingOwner>>
Finalize == /\ ~closed /\ busy = {} /\ quiet = 2 /\ closed' = TRUE
            /\ idleNotices' = IF needs \/ owner # "user" THEN idleNotices ELSE idleNotices \cup {episode}
            /\ UNCHANGED <<episode, busy, pending, quiet, needs, needNotices, background, owner, pendingUser, jobOwner, pendingOwner>>
Background == /\ background' = ~background
              /\ UNCHANGED <<episode, busy, pending, quiet, closed, needs, idleNotices, needNotices, owner, pendingUser, jobOwner, pendingOwner>>
\* Reconnect/restart does not synthesize settlement or clear durable episode IDs.
Reconnect == UNCHANGED vars
UserAdmission == /\ owner' = (IF closed THEN owner ELSE "user") /\ pendingUser' = closed
                 /\ UNCHANGED <<episode, busy, pending, quiet, closed, needs, idleNotices, needNotices, background, jobOwner, pendingOwner>>
LaunchJob == /\ ~closed /\ jobOwner = "none" /\ jobOwner' \in {owner, "unknown"}
             /\ UNCHANGED <<episode, busy, pending, quiet, closed, needs, idleNotices, needNotices, background, owner, pendingUser, pendingOwner>>
CompleteJob == /\ jobOwner # "none"
               /\ owner' = IF ~closed /\ jobOwner = "user" THEN "user" ELSE owner
               /\ pendingOwner' = IF closed THEN jobOwner ELSE pendingOwner
               /\ pendingUser' = pendingUser
               /\ jobOwner' = "none"
               /\ UNCHANGED <<episode, busy, pending, quiet, closed, needs, idleNotices, needNotices, background>>
Next == (\E a \in Actors: (\E source \in {"user", "cron", "background"}: Start(a, source)) \/ Settle(a) \/ Queue(a) \/ Drain(a) \/ NeedsYou(a))
        \/ Tick \/ Resolve \/ Finalize \/ Background \/ Reconnect \/ UserAdmission \/ LaunchJob \/ CompleteJob
TypeOK == /\ pendingOwner \in {"none", "user", "cron", "unknown"} /\ jobOwner \in {"none", "user", "cron", "unknown"} /\ pendingUser \in BOOLEAN /\ owner \in {"user", "cron", "unknown"} /\ episode \in 0..MaxEpisodes /\ busy \subseteq Actors /\ pending \subseteq Actors
          /\ quiet \in 0..2 /\ closed \in BOOLEAN /\ needs \in BOOLEAN /\ background \in BOOLEAN
          /\ idleNotices \subseteq 1..episode /\ needNotices \subseteq 1..episode
NoPrematureIdle == episode \in idleNotices => closed /\ busy = {} /\ quiet = 2
NoRelatedDoublePing == closed /\ needs => episode \notin idleNotices
CronIntentNotBypassed == owner # "user" => episode \notin idleNotices
Spec == Init /\ [][Next /\ UNCHANGED observation]_<<vars, observation>>

\* One uninterrupted supervisor observation owns its newly read projection.
\* Cases abstract SQL rows/options; only the external control mutates between reads.
\* work folds working/streaming rows; attention means pending and unexpired.
\* The version also abstracts a changed display title on the next observation.
SnapshotCases == LET base == [work |-> {}, live |-> {}, starting |-> {}, open |-> TRUE,
                              quietAge |-> 2, episodeOwner |-> "user", userPending |-> FALSE,
                              handoffOwner |-> "none", attention |-> FALSE, jobs |-> 0]
                 IN <<base,
                      [base EXCEPT !.work = Actors \ {Root}],
                      [base EXCEPT !.work = {Root}],
                      [base EXCEPT !.live = Actors \ {Root}],
                      [base EXCEPT !.starting = Actors \ {Root}],
                      [base EXCEPT !.quietAge = 0], [base EXCEPT !.quietAge = 1],
                      [base EXCEPT !.episodeOwner = "cron"], [base EXCEPT !.episodeOwner = "unknown"],
                      [base EXCEPT !.attention = TRUE],
                      [base EXCEPT !.jobs = 1], [base EXCEPT !.jobs = 2],
                      [base EXCEPT !.open = FALSE],
                      [base EXCEPT !.open = FALSE, !.work = {Root}, !.episodeOwner = "cron", !.userPending = TRUE],
                      [base EXCEPT !.open = FALSE, !.work = Actors \ {Root}, !.handoffOwner = "cron"],
                      [base EXCEPT !.open = FALSE, !.live = Actors \ {Root}, !.handoffOwner = "unknown"]>>
SnapshotProjection(i, n) == [index |-> i, version |-> n]
SnapshotDecision(p, rootOnly) ==
    IF p.index = 0 THEN [action |-> "cancel", episodeOwner |-> "none", jobs |-> 0, title |-> p.version]
    ELSE LET s == SnapshotCases[p.index]
             active == (s.work \cup s.live) \cap (IF rootOnly THEN {Root} ELSE Actors)
             starting == s.starting \cap (IF rootOnly THEN {Root} ELSE Actors)
             nextOwner == IF s.userPending THEN "user" ELSE IF s.handoffOwner # "none" THEN s.handoffOwner ELSE s.episodeOwner
             action == IF active # {} THEN IF s.open THEN "active" ELSE "open"
                       ELSE IF ~s.open THEN "inert" ELSE IF starting # {} THEN "starting"
                       ELSE IF s.quietAge = 0 THEN "quietAge" ELSE IF s.quietAge = 1 THEN "wait"
                       ELSE IF s.episodeOwner = "user" /\ ~s.attention THEN "idle" ELSE "close"
         IN [action |-> action, episodeOwner |-> IF action = "open" THEN nextOwner ELSE s.episodeOwner,
             jobs |-> IF action = "idle" THEN s.jobs ELSE 0, title |-> p.version]
SnapshotPick(policy) ==
    /\ observation.phase = "pick"
    /\ \E i \in 0..Len(SnapshotCases), entry \in {"supplied", "default", "undefined", "null"}:
          /\ (policy # "external" \/ (i = 1 /\ entry = "supplied"))
          /\ (policy # "stale" \/ observation.n = 0 \/ i # observation.previous.index)
          /\ observation' = [observation EXCEPT !.phase = "capture", !.current = i, !.entry = entry]
SnapshotCapture ==
    /\ observation.phase = "capture"
    /\ observation' = [observation EXCEPT !.phase = "captured",
          !.outer = SnapshotProjection(IF observation.entry = "null" THEN 0 ELSE observation.current, observation.n),
          !.reads = IF observation.entry = "supplied" THEN 1 ELSE 0]
SnapshotEnter(policy) ==
    /\ observation.phase = "captured"
    /\ observation' = [observation EXCEPT !.phase = "observe",
          !.current = IF policy = "external" THEN 2 ELSE observation.current]
SnapshotObserve(policy) ==
    /\ observation.phase = "observe"
    /\ LET o == observation
           direct == o.entry \in {"default", "undefined"}
           fallback == o.entry = "null" /\ policy = "nullfallback"
           used == IF o.entry = "null" /\ ~fallback THEN SnapshotProjection(0, o.n)
                   ELSE IF direct \/ fallback THEN SnapshotProjection(o.current, o.n)
                   ELSE IF policy = "stale" /\ o.n = 1 THEN o.previous ELSE o.outer
           reference == SnapshotProjection(IF o.entry = "null" THEN 0 ELSE o.current, o.n)
           extra == IF direct \/ fallback \/ (policy = "reread" /\ o.entry = "supplied" /\ o.outer.index # 0) THEN 1 ELSE 0
       IN observation' = [o EXCEPT !.phase = "done", !.used = used,
            !.expected = SnapshotDecision(reference, FALSE), !.result = SnapshotDecision(used, policy = "rootonly"),
            !.reads = @ + extra,
            !.oldReads = IF o.entry = "null" THEN 0 ELSE IF o.entry = "supplied" /\ o.outer.index # 0 THEN 2 ELSE 1]
SnapshotAgain ==
    /\ observation.phase = "done" /\ observation.n = 0
    /\ observation' = [SnapshotInitial EXCEPT !.n = 1, !.previous = observation.outer]
SnapshotNext(policy) == /\ (SnapshotPick(policy) \/ SnapshotCapture \/ SnapshotEnter(policy) \/ SnapshotObserve(policy) \/ SnapshotAgain)
                        /\ UNCHANGED vars
SnapshotEquivalent == observation.phase = "done" => observation.result = observation.expected
SnapshotNoFallback == observation.phase = "done" /\ observation.entry = "null" => observation.reads = 0 /\ observation.used.index = 0
SnapshotOneRead == observation.phase = "done" => observation.reads = (IF observation.entry = "null" THEN 0 ELSE 1)
SnapshotFresh == observation.phase = "done" => observation.used = SnapshotProjection(IF observation.entry = "null" THEN 0 ELSE observation.current, observation.n)
SnapshotSameProjection == observation.phase = "done" /\ observation.entry = "supplied" => observation.used = observation.outer
SnapshotWorkRemoved == observation.phase = "done" => observation.oldReads >= observation.reads
SnapshotSpec == Init /\ [][SnapshotNext("correct")]_<<vars, observation>>
SnapshotRereadSpec == Init /\ [][SnapshotNext("reread")]_<<vars, observation>>
SnapshotStaleSpec == Init /\ [][SnapshotNext("stale")]_<<vars, observation>>
SnapshotNullFallbackSpec == Init /\ [][SnapshotNext("nullfallback")]_<<vars, observation>>
SnapshotRootOnlySpec == Init /\ [][SnapshotNext("rootonly")]_<<vars, observation>>
\* Expected non-equivalence: another connection changes sessions between old reads.
SnapshotExternalSpec == Init /\ [][SnapshotNext("external")]_<<vars, observation>>
=======================================================================
