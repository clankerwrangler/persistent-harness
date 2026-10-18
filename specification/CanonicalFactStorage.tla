-------------------- MODULE CanonicalFactStorage --------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS BadRetainEmpty, BadDropFacts
VARIABLES inventory, selected, generation, stored, published, rejected
vars == <<inventory, selected, generation, stored, published, rejected>>
Entries == {"plain", "call", "result", "observation", "invalid"}
Kinds == {"calls", "results", "aliases", "observedAliases"}
Raw(e,k) == CASE e = "call" /\ k \in {"calls", "aliases"} -> {"native"}
             [] e = "result" /\ k \in {"results", "aliases"} -> {"native"}
             [] e = "observation" /\ k = "observedAliases" -> {"veto"}
             [] OTHER -> {}
Encode(e) == [k \in Kinds |-> [present |-> BadRetainEmpty \/ Raw(e,k) # {}, values |-> IF BadDropFacts THEN {} ELSE Raw(e,k)]]
Decode(e,k) == IF stored[e][k].present THEN stored[e][k].values ELSE {}
Init == /\ inventory = {} /\ selected = {} /\ generation = 0
        /\ stored = [e \in {} |-> Encode(e)] /\ published = [status |-> "none", values |-> [k \in Kinds |-> {}]] /\ rejected = FALSE
Ingest(e) == /\ e \notin inventory
             /\ inventory' = inventory \cup {e}
             /\ stored' = stored @@ (e :> Encode(e))
             /\ UNCHANGED <<selected,generation,published,rejected>>
Select == /\ selected' \in SUBSET inventory /\ published' = [status |-> "none", values |-> [k \in Kinds |-> {}]]
          /\ UNCHANGED <<inventory,generation,stored,rejected>>
Fold == /\ rejected' = ("invalid" \in selected)
        /\ published' = [status |-> IF "invalid" \in selected THEN "rejected" ELSE "ready",
                         values |-> [k \in Kinds |-> UNION {Decode(e,k) : e \in selected}]]
        /\ UNCHANGED <<inventory,selected,generation,stored>>
Reload == /\ generation = 0 /\ generation' = 1
          /\ inventory' = {} /\ selected' = {} /\ stored' = [e \in {} |-> Encode(e)]
          /\ published' = [status |-> "none", values |-> [k \in Kinds |-> {}]] /\ rejected' = FALSE
Next == (\E e \in Entries : Ingest(e)) \/ Select \/ Fold \/ Reload
Spec == Init /\ [][Next]_vars
SparseStorage == \A e \in inventory, k \in Kinds : stored[e][k].present = (Raw(e,k) # {})
ExactFacts == \A e \in inventory, k \in Kinds : Decode(e,k) = Raw(e,k)
SelectedParity == published.status # "none" =>
    /\ rejected = ("invalid" \in selected)
    /\ IF rejected THEN published.status = "rejected"
       ELSE published.values = [k \in Kinds |-> UNION {Raw(e,k) : e \in selected}]
=============================================================================
