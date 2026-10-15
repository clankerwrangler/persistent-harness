-------------------------- MODULE DescendantTraversal --------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Nodes, Target, NoParent
VARIABLES parent, parentIndex, deleted, working, visited, frontier, steps
vars == <<parent, parentIndex, deleted, working, visited, frontier, steps>>
\* SQLite owns this derived full index, including tombstones used by deletion.
ParentEdges == {<<parent[n], n>> : n \in Nodes}
ScanChildren(id) == {n \in Nodes \ deleted : parent[n] = id}
Children(id) == {n \in Nodes \ deleted : <<id, n>> \in parentIndex}
RECURSIVE Reach(_)
Reach(depth) == IF depth = 0 THEN ScanChildren(Target)
                ELSE LET previous == Reach(depth - 1)
                     IN previous \cup UNION {ScanChildren(n) : n \in previous}
Expected == Reach(Cardinality(Nodes)) \ {Target}
Count == Cardinality((visited \ {Target}) \cap working)
Init == /\ parent \in [Nodes -> Nodes \cup {NoParent}]
        /\ parentIndex = ParentEdges
        /\ deleted \in SUBSET Nodes /\ working \in SUBSET Nodes
        /\ visited = {} /\ frontier = Children(Target) /\ steps = 0
\* SQL UNION admits each ID once, even across repeated edges or a cycle.
Step == \E n \in frontier:
          /\ visited' = visited \cup {n}
          /\ frontier' = (frontier \cup Children(n)) \ visited'
          /\ steps' = steps + 1
          /\ UNCHANGED <<parent, parentIndex, deleted, working>>
Done == /\ frontier = {} /\ UNCHANGED vars
Next == Step \/ Done
TypeOK == /\ visited \subseteq Nodes /\ frontier \subseteq Nodes
          /\ visited \cap frontier = {}
FiniteTraversal == steps = Cardinality(visited) /\ steps <= Cardinality(Nodes)
DeletedExcluded == visited \cap deleted = {}
CorrectCount == frontier = {} => Count = Cardinality(Expected \cap working)
NoSelfCount == Count = Cardinality((visited \cap working) \ {Target})
IndexEquivalent == parentIndex = ParentEdges /\ \A n \in Nodes: Children(n) = ScanChildren(n)
EventuallyDone == <> (frontier = {})
Spec == Init /\ [][Next]_vars /\ WF_vars(Step)
===============================================================================
