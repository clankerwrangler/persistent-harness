------------------------- MODULE ActorCompileCache -------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Actors, MaxGeneration, WaitForWriters, RevalidateOnHit, CheckSource
VARIABLES daemon, cache, setupCount, mode, phase, generation, source, compiled,
          loaded, selected, validated, runtimeIdentity, usesCache, removedWithWriters
vars == <<daemon, cache, setupCount, mode, phase, generation, source, compiled,
          loaded, selected, validated, runtimeIdentity, usesCache, removedWithWriters>>
Inactive(a) == phase[a] \in {"idle", "exited"}
Writers == {a \in Actors: ~Inactive(a)}
Init == /\ daemon = "running" /\ cache = "absent" /\ setupCount = 0
        /\ mode \in {"default", "disabled", "external"}
        /\ phase = [a \in Actors |-> "idle"] /\ generation = [a \in Actors |-> 0]
        /\ source = 1 /\ compiled = {} /\ loaded = [a \in Actors |-> 0]
        /\ selected = [a \in Actors |-> 0] /\ validated = [a \in Actors |-> FALSE]
        /\ runtimeIdentity = [a \in Actors |-> <<a, 0>>]
        /\ usesCache = [a \in Actors |-> FALSE] /\ removedWithWriters = FALSE
Launch(a) == /\ daemon = "running" /\ Inactive(a) /\ generation[a] < MaxGeneration
             /\ generation' = [generation EXCEPT ![a] = @ + 1]
             /\ phase' = [phase EXCEPT ![a] = "waiting"]
             /\ validated' = [validated EXCEPT ![a] = FALSE]
             /\ usesCache' = [usesCache EXCEPT ![a] = FALSE]
             /\ cache' = IF cache = "absent" THEN (IF mode = "default" THEN "creating" ELSE "off") ELSE cache
             /\ setupCount' = IF cache = "absent" /\ mode = "default" THEN setupCount + 1 ELSE setupCount
             /\ UNCHANGED <<daemon, mode, source, compiled, loaded, selected, runtimeIdentity, removedWithWriters>>
Setup == /\ cache = "creating" /\ cache' \in {"private", "unavailable"}
         /\ UNCHANGED <<daemon, setupCount, mode, phase, generation, source, compiled,
                        loaded, selected, validated, runtimeIdentity, usesCache, removedWithWriters>>
Load(a) == LET hit == cache = "private" /\ source \in compiled IN
           /\ phase[a] = "waiting" /\ cache \in {"private", "unavailable", "off", "replaced"}
           /\ phase' = [phase EXCEPT ![a] = "loaded"]
           /\ selected' = [selected EXCEPT ![a] = source]
           /\ loaded' = [loaded EXCEPT ![a] = IF ~CheckSource /\ compiled # {} THEN 1 ELSE source]
           /\ validated' = [validated EXCEPT ![a] = RevalidateOnHit \/ ~hit]
           /\ runtimeIdentity' = [runtimeIdentity EXCEPT ![a] = <<a, generation[a]>>]
           /\ usesCache' = [usesCache EXCEPT ![a] = cache = "private"]
           /\ UNCHANGED <<daemon, cache, setupCount, mode, generation, source, compiled, removedWithWriters>>
Ready(a) == /\ daemon = "running" /\ phase[a] = "loaded"
            /\ phase' = [phase EXCEPT ![a] = "ready"]
            /\ UNCHANGED <<daemon, cache, setupCount, mode, generation, source, compiled,
                           loaded, selected, validated, runtimeIdentity, usesCache, removedWithWriters>>
Exit(a) == /\ phase[a] \in {"loaded", "ready"}
           /\ phase' = [phase EXCEPT ![a] = "exited"]
           /\ compiled' = IF usesCache[a] /\ cache = "private" THEN compiled \cup {loaded[a]} ELSE compiled
           /\ UNCHANGED <<daemon, cache, setupCount, mode, generation, source,
                          loaded, selected, validated, runtimeIdentity, usesCache, removedWithWriters>>
ChangeSource == /\ source = 1 /\ source' = 2
                /\ UNCHANGED <<daemon, cache, setupCount, mode, phase, generation, compiled,
                               loaded, selected, validated, runtimeIdentity, usesCache, removedWithWriters>>
ReplaceDirectory == /\ cache = "private" /\ cache' = "replaced"
                    /\ UNCHANGED <<daemon, setupCount, mode, phase, generation, source, compiled,
                                   loaded, selected, validated, runtimeIdentity, usesCache, removedWithWriters>>
Stop == /\ daemon = "running" /\ daemon' = "stopping"
        /\ UNCHANGED <<cache, setupCount, mode, phase, generation, source, compiled,
                       loaded, selected, validated, runtimeIdentity, usesCache, removedWithWriters>>
Dispose == /\ daemon = "stopping" /\ cache # "creating"
           /\ (~WaitForWriters \/ Writers = {})
           /\ daemon' = "stopped"
           /\ cache' = IF cache = "private" THEN "removed" ELSE cache
           /\ removedWithWriters' = (cache = "private" /\ Writers # {})
           /\ UNCHANGED <<setupCount, mode, phase, generation, source, compiled,
                          loaded, selected, validated, runtimeIdentity, usesCache>>
Next == Setup \/ ChangeSource \/ ReplaceDirectory \/ Stop \/ Dispose
        \/ (\E a \in Actors: Launch(a) \/ Load(a) \/ Ready(a) \/ Exit(a))
OneCacheOwner == setupCount <= 1 /\ (mode # "default" => setupCount = 0)
CacheOutlivesWriters == ~removedWithWriters
FreshRuntime == \A a \in Actors: phase[a] \in {"loaded", "ready"} => runtimeIdentity[a] = <<a, generation[a]>>
ReadyValidated == \A a \in Actors: phase[a] = "ready" => validated[a]
CurrentSource == \A a \in Actors: phase[a] \in {"loaded", "ready"} => loaded[a] = selected[a]
FallbackCanLoad == \A a \in Actors: phase[a] = "waiting" /\ cache \in {"unavailable", "off", "replaced"} => ENABLED Load(a)
Spec == Init /\ [][Next]_vars
=============================================================================
