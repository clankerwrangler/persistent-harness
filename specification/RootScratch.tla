-------------------------- MODULE RootScratch --------------------------
\* Sources:
\*   src/session-scratch.mjs sha256:a2a94a3dfd9c3e476cd845ac9cab3b3026a8d5c6e42ebe935a0f28218495cfe9
\*   src/store.mjs sha256:321247cfd4fcdff36e33af0670e59a501ab67e19328b29387b64a78dc37553a2
\*   src/supervisor.mjs sha256:f98ce08909ebba0dbc34e8121dac397e068d8fe32d0c21c5eb4017a434b628bb
\*   src/process-ownership.mjs sha256:efa41d00c5b4c1bf61ca2eeff513d9c97b2ca9b794a376a32ed12a41f6d4b9d8
\*   src/background-notifier.mjs sha256:5a196d023ebf583d7ff892c3d2ea6e648cacb21f61dff1fb5a9e103c216cc4d7
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
