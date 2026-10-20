-------------------- MODULE OperationsMemory --------------------
EXTENDS Integers, TLC
CONSTANT Bug
VARIABLES sample, host, parentCurrent, parentMax, parentHigh, known, phase, usable, available
vars == <<sample,host,parentCurrent,parentMax,parentHigh,known,phase,usable,available>>
Min(a,b) == IF a < b THEN a ELSE b
Max(a,b) == IF a > b THEN a ELSE b
Samples == {
 [current |-> 8, cap |-> 10, file |-> 6, inactive |-> 6, shmem |-> 0, dirty |-> 0, writeback |-> 0, swap |-> 9],
 [current |-> 8, cap |-> 10, file |-> 6, inactive |-> 6, shmem |-> 2, dirty |-> 1, writeback |-> 1, swap |-> 0],
 [current |-> 12, cap |-> 10, file |-> 6, inactive |-> 6, shmem |-> 0, dirty |-> 0, writeback |-> 0, swap |-> 0],
 [current |-> 10, cap |-> 10, file |-> 6, inactive |-> 6, shmem |-> 6, dirty |-> 0, writeback |-> 0, swap |-> 8],
 [current |-> 8, cap |-> 10, file |-> 2, inactive |-> 6, shmem |-> 0, dirty |-> 2, writeback |-> 1, swap |-> 0]}
Clean(s) == Max(0, Min(s.file,s.inactive) - s.shmem - s.dirty - s.writeback)
Credit(s) == Clean(s)
Leaf(s,r) == Max(0,s.cap-s.current+Min(r,s.current))
Parent(r) == Max(0,Min(parentMax,parentHigh)-parentCurrent+Min(r,parentCurrent))
HardParent(r) == Max(0,parentMax-parentCurrent+Min(r,parentCurrent))
ExpectedHard == IF known THEN Min(host,Min(Leaf(sample,Credit(sample)),HardParent(Credit(sample)))) ELSE -1
Expected == IF known THEN Min(host,Min(Leaf(sample,Credit(sample)),Parent(Credit(sample)))) ELSE -1
Init == /\ sample \in Samples /\ host \in {0,2,8}
        /\ parentCurrent \in {4,12} /\ parentMax \in {9,15} /\ parentHigh \in {7,15}
        /\ known \in BOOLEAN /\ phase = "read" /\ usable = -1 /\ available = -1
Compute == /\ phase = "read" /\ phase' = "done"
 /\ usable' = (CASE Bug = "raw" -> IF known THEN Min(host,Min(Leaf(sample,0),Parent(0))) ELSE -1
                [] Bug = "full" -> IF known THEN Min(host,Min(Leaf(sample,sample.file),Parent(sample.file))) ELSE -1
                [] Bug = "ancestor" -> IF known THEN Min(host,Leaf(sample,Credit(sample))) ELSE -1
                [] Bug = "host" -> IF known THEN Min(Leaf(sample,Credit(sample)),Parent(Credit(sample))) ELSE -1
                [] Bug = "swap" -> IF known THEN Min(host,Min(Leaf(sample,Credit(sample)+sample.swap),Parent(Credit(sample)+sample.swap))) ELSE -1
                [] Bug = "unknown" -> Min(host,Min(Leaf(sample,Credit(sample)),Parent(Credit(sample))))
                [] Bug = "high" -> IF known THEN Min(host,Min(Leaf(sample,Credit(sample)),Max(0,parentMax-parentCurrent+Credit(sample)))) ELSE -1
                [] Bug = "debt" -> IF known THEN Min(host,Min(Max(0,sample.cap-sample.current)+Credit(sample),Parent(Credit(sample)))) ELSE -1
                [] OTHER -> Expected)
 /\ available' = (IF Bug = "conflate" THEN Expected ELSE ExpectedHard)
 /\ UNCHANGED <<sample,host,parentCurrent,parentMax,parentHigh,known>>
Next == Compute
Spec == Init /\ [][Next]_vars
Accounting == phase = "done" => usable = Expected
HardAccounting == phase = "done" => available = ExpectedHard
CleanOnly == Credit(sample) <= Min(sample.file,sample.inactive)
HostBound == phase = "done" /\ known => usable <= host
UnknownUnavailable == phase = "done" /\ ~known => usable = -1
=============================================================================
