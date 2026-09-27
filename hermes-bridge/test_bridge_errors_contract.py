"""Contract tests for the Hermes error envelope (spec Phase 1.4).

The point of the envelope is that the UI switches on `code` instead of matching
message strings, so these tests pin the *contract*, not prose: the code enum is
closed, retryability is derived from the code rather than decided per call site,
and every error the bridge emits is shaped the same way.
"""

import json
import unittest

import bridge_errors as be


class ErrorCodeEnumTests(unittest.TestCase):
    def test_enum_is_exactly_the_nine_contract_codes(self):
        self.assertEqual(len(be.ERROR_CODES), 9)
        self.assertEqual(len(set(be.ERROR_CODES)), 9, "codes must be unique")

    def test_bridge_error_rejects_an_undeclared_code(self):
        with self.assertRaises(ValueError):
            be.BridgeError("NOT_A_REAL_CODE", "boom")

    def test_retryability_defaults_come_from_the_code(self):
        self.assertTrue(be.is_retryable(be.UPSTREAM_TIMEOUT))
        self.assertTrue(be.is_retryable(be.BRIDGE_STARTING))
        self.assertFalse(be.is_retryable(be.MODEL_INCOMPATIBLE))
        self.assertFalse(be.is_retryable(be.VALIDATION))
        self.assertFalse(be.is_retryable(be.BRIDGE_AUTH))

    def test_explicit_retryable_overrides_the_default(self):
        # A provider error is retryable by default, but a specific 400 from the
        # provider is not, and the call site knows that.
        self.assertTrue(be.BridgeError(be.PROVIDER_ERROR, "x").retryable)
        self.assertFalse(be.BridgeError(be.PROVIDER_ERROR, "x", retryable=False).retryable)
        # And a code that is not retryable by default can opt in.
        self.assertTrue(be.BridgeError(be.VALIDATION, "x", retryable=True).retryable)


class EnvelopeShapeTests(unittest.TestCase):
    def test_envelope_is_always_wrapped_in_error(self):
        envelope = be.BridgeError(be.INTERNAL, "boom").to_envelope()
        self.assertEqual(list(envelope), ["error"])
        self.assertEqual(set(envelope["error"]), {"code", "message", "retryable"})

    def test_details_are_omitted_when_empty_not_sent_as_null(self):
        # A `details: null` on every error is noise; absent is cleaner.
        self.assertNotIn("details", be.BridgeError(be.INTERNAL, "boom").to_envelope())

    def test_details_are_included_when_supplied(self):
        envelope = be.BridgeError(
            be.MODEL_INCOMPATIBLE,
            "nope",
            details={"current_model": "m", "suggested_models": ["a", "b"]},
        ).to_envelope()
        self.assertEqual(
            envelope["error"]["details"],
            {"current_model": "m", "suggested_models": ["a", "b"]},
        )

    def test_envelope_is_json_serialisable(self):
        json.dumps(be.BridgeError(be.PROVIDER_ERROR, "x", details={"a": 1}).to_envelope())

    def test_bridge_error_is_an_exception_and_keeps_its_message(self):
        err = be.BridgeError(be.UPSTREAM_TIMEOUT, "took too long")
        self.assertIsInstance(err, Exception)
        self.assertEqual(str(err), "took too long")

    def test_details_input_is_copied_not_aliased(self):
        # A caller mutating its dict afterwards must not change the envelope.
        details = {"current_model": "m"}
        err = be.BridgeError(be.MODEL_INCOMPATIBLE, "x", details=details)
        details["current_model"] = "changed"
        self.assertEqual(err.to_envelope()["error"]["details"]["current_model"], "m")


class ModelValidationTests(unittest.TestCase):
    """The Pydantic models must accept a well-formed envelope.

    These assert through the dict/serialised form rather than attribute access.
    This suite runs both with real pydantic and with the suite-wide stub, and the
    stub does not build nested models — `HermesErrorEnvelope(**payload).error`
    stays a plain dict there. Testing the serialised output is the invariant that
    actually matters and holds in both environments.
    """

    def test_envelope_model_round_trips(self):
        payload = be.BridgeError(
            be.MODEL_INCOMPATIBLE, "nope", details={"current_model": "m"}
        ).to_envelope()
        model = be.HermesErrorEnvelope(**payload)
        dumped = model.model_dump()
        self.assertEqual(dumped["error"]["code"], be.MODEL_INCOMPATIBLE)
        self.assertEqual(dumped["error"]["message"], "nope")
        self.assertFalse(dumped["error"]["retryable"])

    def test_details_model_retains_an_upstream_extra_field(self):
        # extra="allow": an unknown field is kept, not rejected. Under real
        # pydantic it lands as an attribute; under the stub it lands in
        # model_extra. Accept either, because "kept, not dropped" is the point.
        details = be.HermesErrorDetails(current_model="m", something_new="kept")
        as_attr = getattr(details, "something_new", None)
        in_extra = (getattr(details, "model_extra", None) or {}).get("something_new")
        self.assertEqual(as_attr or in_extra, "kept")

    def test_details_optional_fields_default_to_none(self):
        details = be.HermesErrorDetails()
        self.assertIsNone(getattr(details, "current_model", None))
        self.assertIsNone(getattr(details, "suggested_models", None))


class ImportSafetyTests(unittest.TestCase):
    def test_module_imports_without_a_bridge_or_network(self):
        # bridge_errors is imported by the generator and by main; it must stay
        # pure like bridge_events.
        self.assertTrue(hasattr(be, "ERROR_CODES"))
        self.assertTrue(hasattr(be, "BridgeError"))


if __name__ == "__main__":
    unittest.main()
