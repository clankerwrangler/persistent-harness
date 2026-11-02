---------------------- MODULE DefaultInferenceMove ----------------------
\* Sources:
\*   src/default-inference.mjs sha256:359b5bcb6ad444477af7a769231e343b543ab14f49211045c23b8eecb51016e4
\*   src/store.mjs sha256:321247cfd4fcdff36e33af0670e59a501ab67e19328b29387b64a78dc37553a2
\*   src/supervisor.mjs sha256:f98ce08909ebba0dbc34e8121dac397e068d8fe32d0c21c5eb4017a434b628bb
EXTENDS Naturals
CONSTANTS Sessions, Pinned, Old, New, SettingsFirst

\* A move commits the sessions, then names the new default. A crash can fall
\* between the two. Repeating the request looks for sessions on the current
\* default, so that default must not change until every session has moved.
VARIABLES model, default, step, crashes
vars == <<model, default, step, crashes>>
Following == Sessions \ Pinned
Moved == [s \in Sessions |-> IF s \in Following THEN New ELSE model[s]]
Init == /\ model = [s \in Sessions |-> Old] /\ default = Old
        /\ step = "idle" /\ crashes = 0
Request == /\ step = "idle" /\ default = Old
           /\ step' = "running" /\ UNCHANGED <<model, default, crashes>>
MoveSessions == /\ ~SettingsFirst /\ step = "running"
                /\ model' = Moved /\ step' = "settings" /\ UNCHANGED <<default, crashes>>
WriteSettings == /\ ~SettingsFirst /\ step = "settings"
                 /\ default' = New /\ step' = "idle" /\ UNCHANGED <<model, crashes>>
EarlySettings == /\ SettingsFirst /\ step = "running"
                 /\ default' = New /\ step' = "settings" /\ UNCHANGED <<model, crashes>>
LateSessions == /\ SettingsFirst /\ step = "settings"
                /\ model' = Moved /\ step' = "idle" /\ UNCHANGED <<default, crashes>>
Crash == /\ step # "idle" /\ crashes = 0
         /\ step' = "idle" /\ crashes' = 1 /\ UNCHANGED <<model, default>>
Next == Request \/ MoveSessions \/ WriteSettings \/ EarlySettings \/ LateSessions \/ Crash
Spec == Init /\ [][Next]_vars

PinnedStay == \A s \in Pinned : model[s] = Old
NoStranded == (step = "idle" /\ default = New) => \A s \in Following : model[s] = New
=============================================================================
