"""Chat transports behind /v1/chat/completions (spec 4.2).

- ``base``        ChatTransport protocol, capabilities, ChatContext
- ``drain``       EventChannel + the shared ``drain_to_sse`` loop
- ``selection``   ``select_transport`` — the only place a transport is chosen
- ``agent_loop``  AgentLoopTransport (default)
- ``runs``        RunsTransport (gateway /v1/runs) + ``runs_plan`` decision
- ``acp``         AcpTransport (hermes-acp)
- ``swarm``       SwarmTransport (hands off to /v1/swarm)
- ``passthrough`` PassthroughTransport (provider proxy, no agent)
"""
