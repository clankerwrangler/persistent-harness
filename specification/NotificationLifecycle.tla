-------------------- MODULE NotificationLifecycle --------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Actors, Root, MaxEpisodes
VARIABLES episode, busy, pending, quiet, closed, needs, idleNotices, needNotices, background, owner, pendingUser, jobOwner, pendingOwner
vars == <<episode, busy, pending, quiet, closed, needs, idleNotices, needNotices, background, owner, pendingUser, jobOwner, pendingOwner>>
Init == /\ episode = 0 /\ busy = {} /\ pending = {} /\ quiet = 0
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
Spec == Init /\ [][Next]_vars
=======================================================================
