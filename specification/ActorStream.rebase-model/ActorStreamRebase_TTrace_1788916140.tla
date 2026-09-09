---- MODULE ActorStreamRebase_TTrace_1788916140 ----
EXTENDS Sequences, ActorStreamRebase, TLCExt, Toolbox, Naturals, TLC

_expression ==
    LET ActorStreamRebase_TEExpression == INSTANCE ActorStreamRebase_TEExpression
    IN ActorStreamRebase_TEExpression!expression
----

_trace ==
    LET ActorStreamRebase_TETrace == INSTANCE ActorStreamRebase_TETrace
    IN ActorStreamRebase_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        phase = ("open")
        /\
        acknowledged = (FALSE)
        /\
        beforeClosed = (TRUE)
        /\
        published = (<<>>)
        /\
        body = ("B")
        /\
        observed = (FALSE)
        /\
        canceled = (FALSE)
        /\
        textId = ("text2")
        /\
        executions = (0)
        /\
        native = (TRUE)
        /\
        remainderId = ("segment1")
        /\
        proof = (TRUE)
        /\
        outcome = ("open")
        /\
        snapshot = (<<>>)
    )
----

_init ==
    /\ beforeClosed = _TETrace[1].beforeClosed
    /\ native = _TETrace[1].native
    /\ proof = _TETrace[1].proof
    /\ canceled = _TETrace[1].canceled
    /\ observed = _TETrace[1].observed
    /\ published = _TETrace[1].published
    /\ outcome = _TETrace[1].outcome
    /\ phase = _TETrace[1].phase
    /\ executions = _TETrace[1].executions
    /\ acknowledged = _TETrace[1].acknowledged
    /\ body = _TETrace[1].body
    /\ textId = _TETrace[1].textId
    /\ snapshot = _TETrace[1].snapshot
    /\ remainderId = _TETrace[1].remainderId
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ beforeClosed  = _TETrace[i].beforeClosed
        /\ beforeClosed' = _TETrace[j].beforeClosed
        /\ native  = _TETrace[i].native
        /\ native' = _TETrace[j].native
        /\ proof  = _TETrace[i].proof
        /\ proof' = _TETrace[j].proof
        /\ canceled  = _TETrace[i].canceled
        /\ canceled' = _TETrace[j].canceled
        /\ observed  = _TETrace[i].observed
        /\ observed' = _TETrace[j].observed
        /\ published  = _TETrace[i].published
        /\ published' = _TETrace[j].published
        /\ outcome  = _TETrace[i].outcome
        /\ outcome' = _TETrace[j].outcome
        /\ phase  = _TETrace[i].phase
        /\ phase' = _TETrace[j].phase
        /\ executions  = _TETrace[i].executions
        /\ executions' = _TETrace[j].executions
        /\ acknowledged  = _TETrace[i].acknowledged
        /\ acknowledged' = _TETrace[j].acknowledged
        /\ body  = _TETrace[i].body
        /\ body' = _TETrace[j].body
        /\ textId  = _TETrace[i].textId
        /\ textId' = _TETrace[j].textId
        /\ snapshot  = _TETrace[i].snapshot
        /\ snapshot' = _TETrace[j].snapshot
        /\ remainderId  = _TETrace[i].remainderId
        /\ remainderId' = _TETrace[j].remainderId

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("ActorStreamRebase_TTrace_1788916140.json", _TETrace)

=============================================================================

 Note that you can extract this module `ActorStreamRebase_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `ActorStreamRebase_TEExpression.tla` file takes precedence 
  over the module `ActorStreamRebase_TEExpression` below).

---- MODULE ActorStreamRebase_TEExpression ----
EXTENDS Sequences, ActorStreamRebase, TLCExt, Toolbox, Naturals, TLC

expression == 
    [
        \* To hide variables of the `ActorStreamRebase` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        beforeClosed |-> beforeClosed
        ,native |-> native
        ,proof |-> proof
        ,canceled |-> canceled
        ,observed |-> observed
        ,published |-> published
        ,outcome |-> outcome
        ,phase |-> phase
        ,executions |-> executions
        ,acknowledged |-> acknowledged
        ,body |-> body
        ,textId |-> textId
        ,snapshot |-> snapshot
        ,remainderId |-> remainderId
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_beforeClosedUnchanged |-> beforeClosed = beforeClosed'
        
        \* Format the `beforeClosed` variable as Json value.
        \* ,_beforeClosedJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(beforeClosed)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_beforeClosedModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].beforeClosed # _TETrace[s-1].beforeClosed
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE ActorStreamRebase_TETrace ----
\*EXTENDS IOUtils, ActorStreamRebase, TLC
\*
\*trace == IODeserialize("ActorStreamRebase_TTrace_1788916140.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE ActorStreamRebase_TETrace ----
EXTENDS ActorStreamRebase, TLC

trace == 
    <<
    ([phase |-> "open",acknowledged |-> FALSE,beforeClosed |-> FALSE,published |-> <<>>,body |-> "B",observed |-> FALSE,canceled |-> FALSE,textId |-> "text2",executions |-> 0,native |-> TRUE,remainderId |-> "segment1",proof |-> FALSE,outcome |-> "open",snapshot |-> <<>>]),
    ([phase |-> "open",acknowledged |-> FALSE,beforeClosed |-> TRUE,published |-> <<>>,body |-> "B",observed |-> FALSE,canceled |-> FALSE,textId |-> "text2",executions |-> 0,native |-> TRUE,remainderId |-> "segment1",proof |-> FALSE,outcome |-> "open",snapshot |-> <<>>]),
    ([phase |-> "open",acknowledged |-> FALSE,beforeClosed |-> TRUE,published |-> <<>>,body |-> "B",observed |-> FALSE,canceled |-> FALSE,textId |-> "text2",executions |-> 0,native |-> TRUE,remainderId |-> "segment1",proof |-> TRUE,outcome |-> "open",snapshot |-> <<>>])
    >>
----


=============================================================================

---- CONFIG ActorStreamRebase_TTrace_1788916140 ----

INVARIANT
    _inv

CHECK_DEADLOCK
    \* CHECK_DEADLOCK off because of PROPERTY or INVARIANT above.
    FALSE

INIT
    _init

NEXT
    _next

CONSTANT
    _TETrace <- _trace

ALIAS
    _expression
=============================================================================
\* Generated on Wed Sep 09 01:09:00 UTC 2026