------------------------- MODULE WorkerOwnership -------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Dialogs, NativeTransport, ToolNames, SupportedSdkEntries
VARIABLES phase, activeRuntime, serviceRuntime, activeManager, serviceManager,
          activeActions, serviceActions, flight, serviceFlight, mutation,
          opened, pending, resolved, answers, synced, shutdownRequested, issued, answered, gracefulClosed, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome
vars == <<phase, activeRuntime, serviceRuntime, activeManager, serviceManager,
          activeActions, serviceActions, flight, serviceFlight, mutation,
          opened, pending, resolved, answers, synced, shutdownRequested, issued, answered, gracefulClosed, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
Init == /\ ownerOutcome \in {"accepted", "handled"} /\ rpcOutcome = "none"
        /\ phase = "loaded" /\ factoryKind \in {"harness", "injected"} /\ ownedSlots \in {0, 1, 2}
        /\ commandSources = [owned |-> "inline", companion |-> "companion-entry"] /\ rpcCommandSources = [owned |-> "unread", companion |-> "unread"]
        /\ \E entry \in SupportedSdkEntries: loaderIdentity = [configured |-> entry, sdk |-> entry,
             sdkGraph |-> "selected", helperGraph |-> "selected"]
        /\ toolMetadata = [active |-> ToolNames, service |-> ToolNames, prompt |-> ToolNames]
        /\ activeRuntime = "active" /\ serviceRuntime = "service"
        /\ activeManager = "canonical" /\ serviceManager = "canonical"
        /\ activeActions = "throwing" /\ serviceActions = "stock"
        /\ flight = FALSE /\ serviceFlight = FALSE /\ mutation = FALSE
        /\ opened = {} /\ pending = {} /\ resolved = {} /\ answers = [d \in Dialogs |-> 0]
        /\ synced = FALSE /\ shutdownRequested = FALSE /\ issued = 0 /\ answered = 0 /\ gracefulClosed = FALSE
Bind == /\ phase = "loaded" /\ (factoryKind = "injected" \/ ownedSlots = 1) /\ commandSources.owned = (IF factoryKind = "harness" THEN "owned-entry" ELSE "inline") /\ phase' = "bound" /\ activeActions' = "coordinator"
        /\ UNCHANGED <<activeRuntime, serviceRuntime, activeManager, serviceManager,
             serviceActions, flight, serviceFlight, mutation, opened, pending, resolved, answers, synced, shutdownRequested, issued, answered, gracefulClosed, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
Startup == /\ phase = "bound" /\ phase' = "ready"
           /\ UNCHANGED <<activeRuntime, serviceRuntime, activeManager, serviceManager,
             activeActions, serviceActions, flight, serviceFlight, mutation, opened, pending, resolved, answers, synced, shutdownRequested, issued, answered, gracefulClosed, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
Prompt == /\ phase = "ready" /\ ~mutation /\ ~serviceFlight /\ ~flight
          /\ flight' = TRUE /\ synced' = FALSE
          /\ UNCHANGED <<phase, activeRuntime, serviceRuntime, activeManager, serviceManager,
             activeActions, serviceActions, serviceFlight, mutation, opened, pending, resolved, answers, shutdownRequested, issued, answered, gracefulClosed, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
Settle == /\ flight /\ flight' = FALSE
          /\ UNCHANGED <<phase, activeRuntime, serviceRuntime, activeManager, serviceManager,
             activeActions, serviceActions, serviceFlight, mutation, opened, pending, resolved, answers, synced, shutdownRequested, issued, answered, gracefulClosed, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
ReserveService == /\ phase = "ready" /\ ~flight /\ ~mutation /\ ~serviceFlight
                  /\ mutation' = TRUE /\ synced' = TRUE
                  /\ UNCHANGED <<phase, activeRuntime, serviceRuntime, activeManager, serviceManager,
                       activeActions, serviceActions, flight, serviceFlight, opened, pending, resolved, answers, shutdownRequested, issued, answered, gracefulClosed, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
\* Public summary streams belong to the composed driver under the active owner lease.
StartService == /\ mutation /\ ~serviceFlight /\ serviceFlight' = TRUE
                /\ UNCHANGED <<phase, activeRuntime, serviceRuntime, activeManager, serviceManager,
                     activeActions, serviceActions, flight, mutation, opened, pending, resolved, answers, synced, shutdownRequested, issued, answered, gracefulClosed, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
EndService == /\ mutation /\ serviceFlight' = FALSE /\ mutation' = FALSE
              /\ UNCHANGED <<phase, activeRuntime, serviceRuntime, activeManager, serviceManager,
                   activeActions, serviceActions, flight, opened, pending, resolved, answers, synced, shutdownRequested, issued, answered, gracefulClosed, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
Open(d) == /\ phase \in {"bound", "ready"} /\ d \notin opened
           /\ opened' = opened \cup {d} /\ pending' = pending \cup {d}
           /\ UNCHANGED <<phase, activeRuntime, serviceRuntime, activeManager, serviceManager,
                activeActions, serviceActions, flight, serviceFlight, mutation, resolved, answers, synced, shutdownRequested, issued, answered, gracefulClosed, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
Resolve(d) == /\ d \in pending /\ pending' = pending \ {d} /\ resolved' = resolved \cup {d}
              /\ answers' = [answers EXCEPT ![d] = @ + 1]
              /\ UNCHANGED <<phase, activeRuntime, serviceRuntime, activeManager, serviceManager,
                   activeActions, serviceActions, flight, serviceFlight, mutation, opened, synced, shutdownRequested, issued, answered, gracefulClosed, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
Close == /\ phase # "closed" /\ phase' = "closed" /\ flight' = FALSE
         /\ serviceFlight' = FALSE /\ mutation' = FALSE /\ pending' = {}
         /\ resolved' = resolved \cup pending
         /\ answers' = [d \in Dialogs |-> IF d \in pending THEN answers[d] + 1 ELSE answers[d]]
         /\ UNCHANGED <<activeRuntime, serviceRuntime, activeManager, serviceManager,
              activeActions, serviceActions, opened, synced, shutdownRequested, issued, answered, gracefulClosed, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>

ReceiveCommand == /\ phase = "ready" /\ ~shutdownRequested /\ issued < 2 /\ issued' = issued + 1
                  /\ UNCHANGED <<phase, activeRuntime, serviceRuntime, activeManager, serviceManager,
                       activeActions, serviceActions, flight, serviceFlight, mutation, opened, pending, resolved,
                       answers, synced, shutdownRequested, answered, gracefulClosed, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
RespondCommand == /\ phase = "ready" /\ answered < issued /\ answered' = answered + 1 /\ rpcOutcome' = ownerOutcome
                  /\ UNCHANGED <<phase, activeRuntime, serviceRuntime, activeManager, serviceManager,
                       activeActions, serviceActions, flight, serviceFlight, mutation, opened, pending, resolved,
                       answers, synced, shutdownRequested, issued, gracefulClosed, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome>>
RequestShutdown == /\ phase = "ready" /\ ~shutdownRequested /\ shutdownRequested' = TRUE
                   /\ UNCHANGED <<phase, activeRuntime, serviceRuntime, activeManager, serviceManager,
                        activeActions, serviceActions, flight, serviceFlight, mutation, opened, pending, resolved,
                        answers, synced, issued, answered, gracefulClosed, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
GracefulClose == /\ phase = "ready" /\ shutdownRequested /\ issued = answered /\ pending = {}
                 /\ ~flight /\ ~serviceFlight /\ ~mutation /\ phase' = "closed" /\ gracefulClosed' = TRUE
                 /\ UNCHANGED <<activeRuntime, serviceRuntime, activeManager, serviceManager,
                      activeActions, serviceActions, flight, serviceFlight, mutation, opened, pending, resolved,
                      answers, synced, shutdownRequested, issued, answered, toolMetadata, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
SelectTools(names) == /\ phase \in {"bound", "ready"}
                      /\ toolMetadata' = [active |-> names, service |-> names, prompt |-> names]
                      /\ UNCHANGED <<phase, activeRuntime, serviceRuntime, activeManager, serviceManager,
                           activeActions, serviceActions, flight, serviceFlight, mutation,
                           opened, pending, resolved, answers, synced, shutdownRequested, issued, answered, gracefulClosed, loaderIdentity, commandSources, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
\* The public loader override identifies only our inline factory before binding.
IdentifyInline == /\ phase = "loaded" /\ factoryKind = "harness" /\ ownedSlots = 1 /\ commandSources.owned = "inline"
                  /\ commandSources' = [commandSources EXCEPT !.owned = "owned-entry"]
                  /\ UNCHANGED <<phase, activeRuntime, serviceRuntime, activeManager, serviceManager,
                       activeActions, serviceActions, flight, serviceFlight, mutation, opened, pending, resolved,
                       answers, synced, shutdownRequested, issued, answered, gracefulClosed, toolMetadata, loaderIdentity, rpcCommandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
GetCommands == /\ phase = "ready" /\ rpcCommandSources' = commandSources
               /\ UNCHANGED <<phase, activeRuntime, serviceRuntime, activeManager, serviceManager,
                    activeActions, serviceActions, flight, serviceFlight, mutation, opened, pending, resolved,
                    answers, synced, shutdownRequested, issued, answered, gracefulClosed, toolMetadata, loaderIdentity, commandSources, factoryKind, ownedSlots, ownerOutcome, rpcOutcome>>
Next == IdentifyInline \/ GetCommands \/ (\E names \in SUBSET ToolNames: SelectTools(names)) \/ ReceiveCommand \/ RespondCommand \/ RequestShutdown \/ GracefulClose \/ Bind \/ Startup \/ Prompt \/ Settle \/ ReserveService \/ StartService \/ EndService \/ Close
        \/ (\E d \in Dialogs: Open(d) \/ Resolve(d))
SeparateRuntime == activeRuntime # serviceRuntime /\ serviceActions = "stock"
OneLiteralManager == activeManager = serviceManager /\ activeManager = "canonical"
OwnedReadiness == phase = "ready" => activeActions = "coordinator"
HeaderCapableTransport == phase = "ready" => NativeTransport = "header-capable"
NoConcurrentServiceFlight == ~(flight /\ (serviceFlight \/ mutation))
ServiceLease == serviceFlight => mutation /\ synced
ActiveCompactionOwner == serviceFlight => activeActions = "coordinator" /\ activeManager = serviceManager
ActiveNavigationOwner == mutation => activeActions = "coordinator" /\ activeManager = serviceManager /\ serviceActions = "stock"
OneDialogAnswer == \A d \in Dialogs: answers[d] <= 1
DialogCorrelation == pending \cap resolved = {} /\ pending \cup resolved = opened
ClosedDrainsUI == phase = "closed" => pending = {} /\ ~flight /\ ~serviceFlight
GracefulResponseBoundary == gracefulClosed => issued = answered /\ ~flight /\ ~serviceFlight /\ ~mutation /\ pending = {}
ToolMetadataConsistent == toolMetadata.active = toolMetadata.service /\ toolMetadata.active = toolMetadata.prompt
                         /\ toolMetadata.active \subseteq ToolNames
SupportedSdkLoading == loaderIdentity.sdk = loaderIdentity.configured
                       /\ loaderIdentity.sdk \in SupportedSdkEntries
                       /\ loaderIdentity.sdkGraph = loaderIdentity.helperGraph
CommandSourceReadiness == phase = "ready" => commandSources.owned = (IF factoryKind = "harness" THEN "owned-entry" ELSE "inline")
                         /\ (factoryKind = "harness" => ownedSlots = 1)
CommandSourceIsolation == commandSources.companion = "companion-entry"
                          /\ (factoryKind = "injected" => commandSources.owned = "inline")
RpcCommandSourceIntegrity == rpcCommandSources.owned # "unread" => rpcCommandSources = commandSources
InputOutcomeProjection == answered > 0 => rpcOutcome = ownerOutcome
Spec == Init /\ [][Next]_vars
=============================================================================
