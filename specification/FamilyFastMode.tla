---------------------------- MODULE FamilyFastMode ----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS RootA, RootB, Child, Grandchild, NoRoot, Absent, Malformed, Unknown
Sessions == {RootA, RootB, Child, Grandchild}
Roots == {RootA, RootB}
Parent(s) == CASE s = Child -> RootA [] s = Grandchild -> Child [] OTHER -> NoRoot
Depth(s) == CASE s \in Roots -> 0 [] s = Child -> 1 [] OTHER -> 2
\* All sessions deliberately share the same family label; it is never a lookup key.
Family(s) == "local-roots"
Supported(s) == s \in {RootB, Grandchild}
VARIABLES durable, present, deleted, resident, active, sampled, sampledRoot,
          sampledSupported, tier, originalTier, sampleValid
vars == <<durable, present, deleted, resident, active, sampled, sampledRoot,
          sampledSupported, tier, originalTier, sampleValid>>
RECURSIVE Resolve(_, _)
Resolve(s, seen) ==
  IF s \notin Sessions \/ s \notin present \/ s \in deleted \/ s \in seen
     \/ Cardinality(seen) > 2 THEN NoRoot
  ELSE IF s \in Roots THEN IF Depth(s) = 0 /\ Parent(s) = NoRoot THEN s ELSE NoRoot
  ELSE IF Parent(s) \in Sessions /\ Depth(s) = Depth(Parent(s)) + 1
       THEN Resolve(Parent(s), seen \cup {s}) ELSE NoRoot
Root(s) == Resolve(s, {})
Preference(s) == IF Root(s) = NoRoot THEN Unknown
                 ELSE CASE durable[Root(s)] = Absent -> FALSE
                        [] durable[Root(s)] = Malformed -> Unknown
                        [] OTHER -> durable[Root(s)]
Init == /\ durable \in [Sessions -> BOOLEAN \cup {Absent, Malformed}]
        /\ \A s \in Roots: durable[s] \in {FALSE, Absent, Malformed}
        /\ \A s \in Sessions \ Roots: durable[s] = TRUE
        /\ present = Sessions /\ deleted = {} /\ resident = Sessions
        /\ active = NoRoot /\ sampled = FALSE /\ sampledRoot = NoRoot
        /\ sampledSupported = FALSE /\ tier = "auto" /\ originalTier = "auto"
        /\ sampleValid = FALSE
Set(s, enabled) == /\ Root(s) = s /\ s \in Roots /\ Preference(s) \in BOOLEAN
                   /\ durable' = [durable EXCEPT ![s] = enabled]
                   /\ UNCHANGED <<present, deleted, resident, active, sampled, sampledRoot,
                                  sampledSupported, tier, originalTier, sampleValid>>
Start(s) == /\ active = NoRoot /\ s \in resident /\ Preference(s) \in BOOLEAN
            /\ active' = s /\ sampled' = Preference(s) /\ sampledRoot' = Root(s)
            /\ sampledSupported' = Supported(s) /\ sampleValid' = TRUE
            /\ tier' = IF Preference(s) /\ Supported(s) THEN "priority" ELSE "auto"
            /\ originalTier' = tier'
            /\ UNCHANGED <<durable, present, deleted, resident>>
Finish == /\ active # NoRoot /\ active' = NoRoot
          /\ UNCHANGED <<durable, present, deleted, resident, sampled, sampledRoot,
                         sampledSupported, tier, originalTier, sampleValid>>
\* Stop/revive and retained/new admission do not copy a root preference.
Residency(s) == /\ s # active /\ resident' = IF s \in resident THEN resident \ {s} ELSE resident \cup {s}
                /\ UNCHANGED <<durable, present, deleted, active, sampled, sampledRoot,
                               sampledSupported, tier, originalTier, sampleValid>>
Availability(s) == /\ s # active
                  /\ \/ /\ present' = IF s \in present THEN present \ {s} ELSE present \cup {s}
                        /\ UNCHANGED deleted
                     \/ /\ deleted' = IF s \in deleted THEN deleted \ {s} ELSE deleted \cup {s}
                        /\ UNCHANGED present
                  /\ UNCHANGED <<durable, resident, active, sampled, sampledRoot,
                                 sampledSupported, tier, originalTier, sampleValid>>
Next == (\E s \in Sessions: (\E enabled \in BOOLEAN: Set(s, enabled)) \/ Start(s) \/ Residency(s) \/ Availability(s)) \/ Finish
TypeOK == /\ durable \in [Sessions -> BOOLEAN \cup {Absent, Malformed}] /\ active \in Sessions \cup {NoRoot}
          /\ present \subseteq Sessions /\ deleted \subseteq Sessions /\ resident \subseteq Sessions
RootAuthority == \A s \in Sessions \ Roots: durable[s] = TRUE
IndependentRoots == \A s \in Roots: Root(s) \in {s, NoRoot}
ActualAncestry == Root(Child) \in {RootA, NoRoot} /\ Root(Grandchild) \in {RootA, NoRoot}
MissingFailsClosed == \A s \in Sessions: Root(s) = NoRoot => Preference(s) = Unknown
LegacyDefaultOff == \A s \in Sessions: IF Root(s) = NoRoot THEN TRUE
                       ELSE durable[Root(s)] = Absent => Preference(s) = FALSE
MalformedFailsClosed == \A s \in Sessions: IF Root(s) = NoRoot THEN TRUE
                        ELSE durable[Root(s)] = Malformed => Preference(s) = Unknown
ActiveImmutable == active # NoRoot => tier = originalTier
Gated == active # NoRoot => (tier = "priority" <=> sampled /\ sampledSupported)
CanonicalSample == active # NoRoot => sampleValid /\ sampledRoot = (IF active \in Roots THEN active ELSE RootA)
Spec == Init /\ [][Next]_vars
===============================================================================
