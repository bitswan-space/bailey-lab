"""minio → garage service-name migration (the object store was renamed)."""

from app.services.automation_service import migrate_legacy_services


def test_minio_is_renamed_to_garage():
    assert migrate_legacy_services({"minio": {"enabled": True}}) == {
        "garage": {"enabled": True}
    }


def test_garage_and_others_pass_through_untouched():
    svcs = {"garage": {"enabled": True}, "postgres": {"enabled": True}}
    assert migrate_legacy_services(svcs) == svcs


def test_real_garage_wins_when_both_declared():
    # A live garage declaration must not be clobbered by a legacy minio one.
    assert migrate_legacy_services(
        {"minio": {"enabled": False}, "garage": {"enabled": True}}
    ) == {"garage": {"enabled": True}}


def test_empty_and_none_are_safe():
    assert migrate_legacy_services(None) == {}
    assert migrate_legacy_services({}) == {}


def test_idempotent():
    once = migrate_legacy_services({"minio": {"enabled": True}, "postgres": {"enabled": True}})
    assert once == {"garage": {"enabled": True}, "postgres": {"enabled": True}}
    assert migrate_legacy_services(once) == once
