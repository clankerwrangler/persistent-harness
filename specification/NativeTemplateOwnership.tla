------------------------ MODULE NativeTemplateOwnership ------------------------
EXTENDS Naturals, TLC
CONSTANT Fault
(* idleScope names the lexical owner captured by the connection expiry timer. *)
VARIABLES phase, request, external, admitted, expected, stored, storedExpected,
          chain, chainSession, chainAuth, session, auth, prefix, mode, delta,
          expectedDelta, terminal, cancelled, retired, proof, published, copies, idleScope
vars == <<phase, request, external, admitted, expected, stored, storedExpected,
          chain, chainSession, chainAuth, session, auth, prefix, mode, delta,
          expectedDelta, terminal, cancelled, retired, proof, published, copies, idleScope>>
Init == /\ phase = "idle" /\ request = 0 /\ external = 0
        /\ admitted = 2 /\ expected = 2 /\ stored = 2 /\ storedExpected = 2
        /\ chain = FALSE /\ chainSession = 2 /\ chainAuth = 2
        /\ session = 0 /\ auth = 0 /\ prefix = TRUE /\ mode = "cached"
        /\ delta = FALSE /\ expectedDelta = FALSE /\ terminal = FALSE
        /\ cancelled = FALSE /\ retired = TRUE /\ proof = FALSE
        /\ published = FALSE /\ copies = 0 /\ idleScope = "none"
Begin(v,s,a,p,m) ==
 /\ phase = "idle" /\ request < 2
 /\ phase' = "hook" /\ request' = request + 1 /\ external' = v
 /\ session' = s /\ auth' = a /\ prefix' = p /\ mode' = m
 /\ terminal' = FALSE /\ cancelled' = FALSE /\ retired' = FALSE
 /\ proof' = FALSE /\ published' = FALSE /\ copies' = 0
 /\ delta' = FALSE /\ expectedDelta' = FALSE
 /\ UNCHANGED <<admitted,expected,stored,storedExpected,chain,chainSession,chainAuth,idleScope>>
Admit == /\ phase = "hook" /\ phase' = "admitted"
         /\ admitted' = (IF Fault = "Retain" /\ request = 2 THEN admitted ELSE external)
         /\ expected' = external
         /\ UNCHANGED <<request,external,stored,storedExpected,chain,chainSession,
              chainAuth,session,auth,prefix,mode,delta,expectedDelta,terminal,
              cancelled,retired,proof,published,copies,idleScope>>
HookOrJsonError == /\ phase = "hook" /\ phase' = "finished" /\ idleScope' = "none"
 /\ chain' = FALSE /\ retired' = TRUE
 /\ UNCHANGED <<request,external,admitted,expected,stored,storedExpected,
      chainSession,chainAuth,session,auth,prefix,mode,delta,expectedDelta,
      terminal,cancelled,proof,published,copies>>
Mutate == /\ phase = "admitted" /\ phase' = "ready"
 /\ external' = 1 - external
 /\ admitted' = (IF Fault = "Borrow" THEN 1 - external ELSE admitted)
 /\ stored' = (IF Fault = "Expose" /\ chain THEN 1 - stored ELSE stored)
 /\ UNCHANGED <<request,expected,storedExpected,chain,chainSession,chainAuth,
      session,auth,prefix,mode,delta,expectedDelta,terminal,cancelled,retired,
      proof,published,copies,idleScope>>
Send == /\ phase = "ready" /\ phase' = "wire" /\ idleScope' = "none"
 /\ expectedDelta' = (chain /\ mode = "cached" /\ session = chainSession /\
                       auth = chainAuth /\ prefix /\ expected = storedExpected)
 /\ delta' = (IF Fault = "Guards" THEN chain ELSE
                (chain /\ mode = "cached" /\ session = chainSession /\
                 auth = chainAuth /\ prefix /\ admitted = stored))
 /\ UNCHANGED <<request,external,admitted,expected,stored,storedExpected,chain,
      chainSession,chainAuth,session,auth,prefix,mode,terminal,cancelled,retired,
      proof,published,copies>>
Complete == /\ phase = "wire" /\ phase' = "finished"
 /\ terminal' = TRUE /\ proof' = TRUE /\ retired' = TRUE /\ published' = TRUE
 /\ chain' = (mode # "sse")
 /\ idleScope' = (IF mode = "sse" THEN "none" ELSE IF Fault = "RequestScope" THEN "request" ELSE "connection")
 /\ stored' = admitted /\ storedExpected' = expected
 /\ chainSession' = session /\ chainAuth' = auth
 /\ copies' = (IF Fault = "Copy" /\ mode # "sse" THEN 1 ELSE 0)
 /\ UNCHANGED <<request,external,admitted,expected,session,auth,prefix,mode,
      delta,expectedDelta,cancelled>>
CancelOrReadError == /\ phase \in {"admitted","ready","wire"}
 /\ phase' = "finished" /\ cancelled' = TRUE /\ retired' = TRUE /\ chain' = FALSE /\ idleScope' = "none"
 /\ UNCHANGED <<request,external,admitted,expected,stored,storedExpected,
      chainSession,chainAuth,session,auth,prefix,mode,delta,expectedDelta,
      terminal,proof,published,copies>>
Finish == /\ phase = "finished" /\ phase' = "idle"
 /\ UNCHANGED <<request,external,admitted,expected,stored,storedExpected,
      chain,chainSession,chainAuth,session,auth,prefix,mode,delta,expectedDelta,
      terminal,cancelled,retired,proof,published,copies,idleScope>>
Expire == /\ phase = "idle" /\ chain /\ chain' = FALSE /\ idleScope' = "none"
 /\ UNCHANGED <<phase,request,external,admitted,expected,stored,storedExpected,
      chainSession,chainAuth,session,auth,prefix,mode,delta,expectedDelta,terminal,
      cancelled,retired,proof,published,copies>>
Next == (\E v \in 0..1,s \in 0..1,a \in 0..1,p \in BOOLEAN,
             m \in {"cached","direct","sse"}: Begin(v,s,a,p,m))
        \/ Admit \/ HookOrJsonError \/ Mutate \/ Send \/ Complete
        \/ CancelOrReadError \/ Finish \/ Expire
TypeOK == /\ request \in 0..2 /\ external \in 0..1
          /\ admitted \in 0..2 /\ stored \in 0..2
          /\ idleScope \in {"none", "connection", "request"}
AdmittedDetached == phase \in {"admitted","ready","wire","finished"} /\ expected # 2
                    => admitted = expected
StoredPrivate == chain => stored = storedExpected
ContinuationExact == phase \in {"wire","finished"} => delta = expectedDelta
TerminalPublication == published => terminal /\ ~cancelled /\ proof /\ retired
CancelledCleanup == cancelled => retired /\ ~published /\ ~chain
NoSecondClone == copies = 0
NoSettledRequestRoot == phase \in {"finished","idle"} /\ chain => idleScope = "connection"
Spec == Init /\ [][Next]_vars
=============================================================================
