----------------------- MODULE NavigatorAncestorContext -----------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANT Mode
Nodes == 1..5
MaxHops == 3
Shapes == {"shared", "mixed", "cycle", "deleted", "missing", "cutoff"}
VARIABLES shape, pending, seen, expansions
vars == <<shape, pending, seen, expansions>>
Parent(n) == CASE n = 1 -> IF shape = "cycle" THEN 2 ELSE 0
                 [] n = 2 -> 1
                 [] n = 3 -> IF shape = "missing" THEN 6 ELSE 2
                 [] n = 4 -> 3
                 [] OTHER -> CASE shape = "cycle" -> 6
                                  [] shape = "cutoff" -> 4
                                  [] OTHER -> 3
Deleted == IF shape = "deleted" THEN {2} ELSE {}
Candidates == CASE shape = "cutoff" -> <<5>>
                  [] shape = "deleted" -> <<4, 5>>
                  [] shape = "mixed" -> <<4, 2, 5>>
                  [] OTHER -> <<1, 2, 3, 4, 5>>
Seeds == SelectSeq(Candidates, LAMBDA n: Parent(n) # 0)
SeedQueue == [i \in 1..Len(Seeds) |-> <<Parent(Seeds[i]), 1>>]
RECURSIVE Level(_)
Level(h) == IF h = 1 THEN {Parent(n): n \in {Seeds[i]: i \in 1..Len(Seeds)}}
            ELSE {Parent(n): n \in {x \in Level(h-1) \cap Nodes: Parent(x) # 0}}
Reference == UNION {{<<n, h>>: n \in Level(h)}: h \in 1..MaxHops}
Visible(tuples) == {t[1]: t \in tuples} \cap (Nodes \ Deleted)
Init == /\ shape \in Shapes /\ pending = SeedQueue /\ seen = {} /\ expansions = 0
\* SQLite UNION keys the complete (id,hops) tuple. Duplicate expansion cannot
\* add context: each tuple has at most one successor in this statement snapshot.
Step == /\ Len(pending) > 0
        /\ LET t == Head(pending)
               visit == Mode = "Bag" \/ t \notin seen
               follow == visit /\ t[1] \in Nodes
                         /\ (Mode = "Unbounded" \/ t[2] < MaxHops)
                         /\ Parent(t[1]) # 0
                         /\ (Mode # "FilterDeleted" \/ t[1] \notin Deleted)
           IN /\ pending' = IF follow THEN Append(Tail(pending), <<Parent(t[1]), t[2]+1>>) ELSE Tail(pending)
              /\ seen' = IF visit THEN seen \cup {t} ELSE seen
              /\ expansions' = expansions + IF visit THEN 1 ELSE 0
        /\ UNCHANGED shape
Next == Step \/ /\ Len(pending) = 0 /\ UNCHANGED vars
ContextRows == Len(pending) = 0 => Visible(seen) = Visible(Reference)
UniqueExpansions == expansions = Cardinality(seen)
BoundedHops == \A t \in seen: t[2] <= MaxHops
Spec == Init /\ [][Next]_vars
===============================================================================
