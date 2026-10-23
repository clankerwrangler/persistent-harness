--------------------- MODULE OwnedAppendIndex ---------------------
EXTENDS Naturals
CONSTANTS MaxVersion, DurableBit, CheckCursor, ForceStrict, ForceReader
VARIABLES source, epoch, sequence, hintedEpoch, hintedSequence, hintedVersion,
          indexed, cursorEpoch, cursorSequence, unverified, fingerprintChanged,
          readerCache, strict, scanned, returned, badCursor, falseCurrent, rangeAvailable
vars == <<source, epoch, sequence, hintedEpoch, hintedSequence, hintedVersion,
          indexed, cursorEpoch, cursorSequence, unverified, fingerprintChanged,
          readerCache, strict, scanned, returned, badCursor, falseCurrent, rangeAvailable>>
Init == /\ source = 0 /\ epoch = 0 /\ sequence = 0
        /\ hintedEpoch = 0 /\ hintedSequence = 0 /\ hintedVersion = 0
        /\ indexed = 0 /\ cursorEpoch = 0 /\ cursorSequence = 0
        /\ unverified = FALSE /\ fingerprintChanged = FALSE /\ readerCache = 0
        /\ strict = "idle" /\ scanned = 0 /\ returned = FALSE
        /\ badCursor = FALSE /\ falseCurrent = FALSE /\ rangeAvailable = TRUE
OwnedAppend == /\ source < MaxVersion /\ sequence < MaxVersion /\ strict = "idle"
               /\ source' = source + 1 /\ sequence' = sequence + 1
               /\ hintedEpoch' = epoch /\ hintedSequence' = sequence + 1 /\ hintedVersion' = source + 1
               /\ fingerprintChanged' = TRUE
               /\ UNCHANGED <<epoch, indexed, cursorEpoch, cursorSequence, unverified,
                              readerCache, strict, scanned, returned, badCursor, falseCurrent, rangeAvailable>>
AutoIngest == /\ strict = "idle" /\ hintedSequence > cursorSequence
              /\ (~CheckCursor \/ (rangeAvailable /\ hintedEpoch = epoch /\ hintedEpoch = cursorEpoch /\ hintedSequence > cursorSequence))
              /\ indexed' = hintedVersion /\ cursorEpoch' = hintedEpoch /\ cursorSequence' = hintedSequence
              /\ unverified' = TRUE /\ fingerprintChanged' = FALSE
              /\ badCursor' = (badCursor \/ ~rangeAvailable \/ hintedEpoch # epoch \/ hintedEpoch # cursorEpoch)
              /\ UNCHANGED <<source, epoch, sequence, hintedEpoch, hintedSequence, hintedVersion,
                             readerCache, strict, scanned, returned, falseCurrent, rangeAvailable>>
ExternalSameFingerprint == /\ unverified /\ source < MaxVersion /\ strict = "idle"
                           /\ source' = source + 1
                           /\ UNCHANGED <<epoch, sequence, hintedEpoch, hintedSequence, hintedVersion,
                                          indexed, cursorEpoch, cursorSequence, unverified, fingerprintChanged,
                                          readerCache, strict, scanned, returned, badCursor, falseCurrent, rangeAvailable>>
Restart == /\ strict = "idle" /\ epoch < MaxVersion /\ epoch' = epoch + 1
           /\ unverified' = IF DurableBit THEN unverified ELSE FALSE
           /\ UNCHANGED <<source, sequence, hintedEpoch, hintedSequence, hintedVersion,
                          indexed, cursorEpoch, cursorSequence, fingerprintChanged,
                          readerCache, strict, scanned, returned, badCursor, falseCurrent, rangeAvailable>>
Invalidate == /\ strict = "idle" /\ epoch < MaxVersion /\ source < MaxVersion
              /\ epoch' = epoch + 1 /\ source' = source + 1 /\ unverified' = TRUE
              /\ UNCHANGED <<sequence, hintedEpoch, hintedSequence, hintedVersion,
                             indexed, cursorEpoch, cursorSequence, fingerprintChanged,
                             readerCache, strict, scanned, returned, badCursor, falseCurrent, rangeAvailable>>
LoseRange == /\ strict = "idle" /\ rangeAvailable /\ hintedSequence > cursorSequence
             /\ rangeAvailable' = FALSE
             /\ UNCHANGED <<source, epoch, sequence, hintedEpoch, hintedSequence, hintedVersion,
                            indexed, cursorEpoch, cursorSequence, unverified, fingerprintChanged,
                            readerCache, strict, scanned, returned, badCursor, falseCurrent>>
StrictRequest == /\ strict = "idle" /\ strict' = "prepare" /\ returned' = FALSE
                 /\ UNCHANGED <<source, epoch, sequence, hintedEpoch, hintedSequence, hintedVersion,
                                indexed, cursorEpoch, cursorSequence, unverified, fingerprintChanged,
                                readerCache, scanned, badCursor, falseCurrent, rangeAvailable>>
StrictPrepare == /\ strict = "prepare"
                 /\ strict' = IF fingerprintChanged \/ (ForceStrict /\ unverified) THEN "scan" ELSE "return"
                 /\ UNCHANGED <<source, epoch, sequence, hintedEpoch, hintedSequence, hintedVersion,
                                indexed, cursorEpoch, cursorSequence, unverified, fingerprintChanged,
                                readerCache, scanned, returned, badCursor, falseCurrent, rangeAvailable>>
StrictScan == /\ strict = "scan"
              /\ scanned' = IF ForceReader \/ fingerprintChanged THEN source ELSE readerCache
              /\ strict' = "publish"
              /\ UNCHANGED <<source, epoch, sequence, hintedEpoch, hintedSequence, hintedVersion,
                             indexed, cursorEpoch, cursorSequence, unverified, fingerprintChanged,
                             readerCache, returned, badCursor, falseCurrent, rangeAvailable>>
StrictPublish == /\ strict = "publish" /\ indexed' = scanned /\ readerCache' = scanned
                 /\ cursorEpoch' = epoch /\ cursorSequence' = sequence /\ unverified' = FALSE
                 /\ fingerprintChanged' = FALSE /\ strict' = "return" /\ rangeAvailable' = TRUE
                 /\ UNCHANGED <<source, epoch, sequence, hintedEpoch, hintedSequence, hintedVersion,
                                scanned, returned, badCursor, falseCurrent>>
StrictReturn == /\ strict = "return" /\ returned' = TRUE /\ strict' = "done"
                /\ falseCurrent' = (falseCurrent \/ indexed # source \/ unverified)
                /\ UNCHANGED <<source, epoch, sequence, hintedEpoch, hintedSequence, hintedVersion,
                               indexed, cursorEpoch, cursorSequence, unverified, fingerprintChanged,
                               readerCache, scanned, badCursor, rangeAvailable>>
Snapshot == /\ strict = "idle" /\ returned' = FALSE
            /\ UNCHANGED <<source, epoch, sequence, hintedEpoch, hintedSequence, hintedVersion,
                           indexed, cursorEpoch, cursorSequence, unverified, fingerprintChanged,
                           readerCache, strict, scanned, badCursor, falseCurrent, rangeAvailable>>
Next == OwnedAppend \/ AutoIngest \/ ExternalSameFingerprint \/ Restart \/ Invalidate \/ LoseRange \/ StrictRequest
        \/ StrictPrepare \/ StrictScan \/ StrictPublish \/ StrictReturn \/ Snapshot
ContiguousOwnerCursor == ~badCursor
NoFalseFreshResult == ~falseCurrent
SnapshotNeverClaimsCurrent == strict = "idle" => ~returned
Spec == Init /\ [][Next]_vars
=============================================================================
