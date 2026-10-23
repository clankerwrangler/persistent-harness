--------------------- MODULE SessionHistorySnapshot ---------------------
EXTENDS Naturals
CONSTANTS Isolate, ValidateSpans, LabelSnapshot, MaxVersion, HasIndex
VARIABLES source, committed, staged, writing, query, pinned, captured, strict,
          invalidBefore, receiptBefore, returned, unsafe, mislabeled, closed
vars == <<source, committed, staged, writing, query, pinned, captured, strict,
          invalidBefore, receiptBefore, returned, unsafe, mislabeled, closed>>
Init == /\ source = 1 /\ committed = 1 /\ staged = 0 /\ writing = FALSE
        /\ query = "idle" /\ pinned = 0 /\ captured = 0 /\ strict = FALSE
        /\ invalidBefore = 0 /\ receiptBefore = 0 /\ returned = FALSE
        /\ unsafe = FALSE /\ mislabeled = FALSE /\ closed = FALSE
Append == /\ source < MaxVersion /\ source' = source + 1
          /\ UNCHANGED <<committed, staged, writing, query, pinned, captured, strict,
                        invalidBefore, receiptBefore, returned, unsafe, mislabeled, closed>>
Rewrite == /\ source < MaxVersion /\ source' = source + 1 /\ invalidBefore' = source + 1
           /\ UNCHANGED <<committed, staged, writing, query, pinned, captured, strict,
                         receiptBefore, returned, unsafe, mislabeled, closed>>
Receipt == /\ source < MaxVersion /\ source' = source + 1 /\ receiptBefore' = source + 1
           /\ UNCHANGED <<committed, staged, writing, query, pinned, captured, strict,
                         invalidBefore, returned, unsafe, mislabeled, closed>>
Ingest == /\ HasIndex /\ ~closed /\ ~writing /\ staged' = source /\ writing' = TRUE
          /\ UNCHANGED <<source, committed, query, pinned, captured, strict, invalidBefore,
                        receiptBefore, returned, unsafe, mislabeled, closed>>
Publish == /\ ~closed /\ writing /\ committed' = IF staged = source THEN staged ELSE committed
           /\ writing' = FALSE
           /\ UNCHANGED <<source, staged, query, pinned, captured, strict, invalidBefore,
                         receiptBefore, returned, unsafe, mislabeled, closed>>
Take(s) == /\ HasIndex /\ ~closed /\ query = "idle" /\ (~s \/ committed = source)
           /\ pinned' = IF ~Isolate /\ writing THEN staged ELSE committed
           /\ captured' = committed /\ strict' = s /\ query' = "reading"
           /\ UNCHANGED <<source, committed, staged, writing, invalidBefore, receiptBefore,
                         returned, unsafe, mislabeled, closed>>
Hydrate == /\ ~closed /\ query = "reading"
           /\ (~strict \/ pinned = source)
           /\ (~ValidateSpans \/ (pinned >= invalidBefore /\ pinned >= receiptBefore))
           /\ returned' = TRUE /\ query' = "done"
           /\ unsafe' = (unsafe \/ pinned < invalidBefore \/ pinned < receiptBefore)
           /\ mislabeled' = (mislabeled \/ (~strict /\ ~LabelSnapshot))
           /\ UNCHANGED <<source, committed, staged, writing, pinned, captured, strict,
                         invalidBefore, receiptBefore, closed>>
Cancel == /\ query = "reading" /\ query' = "failed"
          /\ UNCHANGED <<source, committed, staged, writing, pinned, captured, strict,
                        invalidBefore, receiptBefore, returned, unsafe, mislabeled, closed>>
Stop == /\ ~closed /\ ~writing /\ query # "reading" /\ closed' = TRUE
        /\ UNCHANGED <<source, committed, staged, writing, query, pinned, captured, strict,
                      invalidBefore, receiptBefore, returned, unsafe, mislabeled>>
Next == Append \/ Rewrite \/ Receipt \/ Ingest \/ Publish \/ Take(FALSE) \/ Take(TRUE) \/ Hydrate \/ Cancel \/ Stop
CommittedSnapshot == pinned <= captured
ValidatedHydration == ~unsafe
HonestFreshness == ~mislabeled
NoDisabledMaintenance == ~HasIndex => ~writing
SnapshotDoesNotWaitForIngest == HasIndex /\ ~closed /\ query = "idle" => ENABLED Take(FALSE)
Spec == Init /\ [][Next]_vars
=============================================================================
