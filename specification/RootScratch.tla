-------------------------- MODULE RootScratch --------------------------
EXTENDS FiniteSets, TLC
CONSTANT Fault, ServiceMarked
Nodes == {"root", "child", "grandchild", "other"}
Family == {"root", "child", "grandchild"}
VARIABLES owned, present, intent, fenced, running, tools, background, deleted,
          stable, removed, usedAfterIntent, legacy
vars == <<owned,present,intent,fenced,running,tools,background,deleted,stable,
          removed,usedAfterIntent,legacy>>
Init == /\ owned=FALSE /\ present=FALSE /\ intent=FALSE /\ fenced=FALSE
        /\ running={} /\ tools={} /\ background={} /\ deleted={} /\ stable=TRUE
        /\ removed=FALSE /\ usedAfterIntent=FALSE /\ legacy=TRUE
Create == /\ ~owned /\ ~present /\ ~intent /\ "root" \notin deleted
          /\ owned'=TRUE /\ present'=TRUE
          /\ UNCHANGED <<intent,fenced,running,tools,background,deleted,stable,removed,usedAfterIntent,legacy>>
Use(s) == /\ s \in Family /\ s \notin deleted /\ owned /\ present /\ ~fenced /\ stable
          /\ (~intent \/ Fault="drop-intent")
          /\ running'=running \cup {s}
          /\ usedAfterIntent'=(usedAfterIntent \/ intent)
          /\ UNCHANGED <<owned,present,intent,fenced,tools,background,deleted,stable,removed,legacy>>
Background(s) == /\ s \in running /\ ~fenced
          /\ background'=background \cup {s}
          /\ UNCHANGED <<owned,present,intent,fenced,running,tools,deleted,stable,removed,usedAfterIntent,legacy>>
Tool(s) == /\ s \in running /\ ~fenced
           /\ tools'=tools \cup {s}
           /\ UNCHANGED <<owned,present,intent,fenced,running,background,deleted,stable,removed,usedAfterIntent,legacy>>
Finish(s) == /\ background'=background \ {s} /\ tools'=tools \ {s}
          /\ UNCHANGED <<owned,present,intent,fenced,running,deleted,stable,removed,usedAfterIntent,legacy>>
Fence == /\ ~fenced /\ fenced'=TRUE
         /\ UNCHANGED <<owned,present,intent,running,tools,background,deleted,stable,removed,usedAfterIntent,legacy>>
Stop == /\ fenced /\ running'=running \ Family
        /\ UNCHANGED <<owned,present,intent,fenced,tools,background,deleted,stable,removed,usedAfterIntent,legacy>>
Commit == /\ fenced /\ running \cap Family = {}
          /\ deleted'=deleted \cup Family /\ fenced'=FALSE
          /\ intent'=owned
          /\ UNCHANGED <<owned,present,running,tools,background,stable,removed,usedAfterIntent,legacy>>
Cleanup == /\ intent /\ present /\ Family \subseteq deleted
           /\ ~(ServiceMarked /\ Fault="count-service")
           /\ (background \cap Family = {} \/ Fault="skip-background")
           /\ (tools \cap Family = {} \/ Fault="skip-tools")
           /\ (stable \/ Fault="follow-links")
           /\ present'=FALSE /\ removed'=TRUE
           /\ UNCHANGED <<owned,intent,fenced,running,tools,background,deleted,stable,usedAfterIntent,legacy>>
Restart == /\ fenced /\ fenced'=FALSE
           /\ intent'=(IF Fault="drop-intent" THEN FALSE ELSE intent)
           /\ UNCHANGED <<owned,present,running,tools,background,deleted,stable,removed,usedAfterIntent,legacy>>
Substitute == /\ present /\ ~removed /\ stable /\ stable'=FALSE
             /\ UNCHANGED <<owned,present,intent,fenced,running,tools,background,deleted,removed,usedAfterIntent,legacy>>
ChildDelete == /\ deleted'=deleted \cup {"child","grandchild"}
              /\ present'=(IF Fault="child-cleans" THEN FALSE ELSE present)
              /\ UNCHANGED <<owned,intent,fenced,running,tools,background,stable,removed,usedAfterIntent,legacy>>
ChildLifetime == owned /\ ~removed => present
Next == ChildDelete \/ Create \/ Fence \/ Stop \/ Cleanup \/ Commit \/ Restart \/ Substitute
        \/ (\E s \in Nodes : Use(s) \/ Background(s) \/ Tool(s) \/ Finish(s))
Spec == Init /\ [][Next]_vars
NoBusyRemoval == removed => running \cap Family = {} /\ background \cap Family = {} /\ tools \cap Family = {}
AvailableCleanup == intent /\ present /\ Family \subseteq deleted /\ stable
  /\ background \cap Family = {} /\ tools \cap Family = {} => ENABLED Cleanup
NoSubstitution == removed => stable
DurableFence == ~usedAfterIntent
ExactLifetime == removed => owned /\ intent
Unrelated == legacy /\ "other" \notin deleted
=============================================================================
