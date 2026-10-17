"""Offline Supabase configuration tests; never read the developer's .env."""

from unittest.mock import Mock

import pytest
import supabase

from app.db import supabase as db


URL = "https://example.supabase.co"
KEY = "sb_publishable_test_only"
URL_ENV = "NEXT_PUBLIC_SUPABASE_URL"
KEY_ENV = "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"


@pytest.fixture(autouse=True)
def isolated_config(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "PROJECT_ROOT", tmp_path)
    for name in (URL_ENV, KEY_ENV, "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"):
        monkeypatch.delenv(name, raising=False)
    db.get_supabase.cache_clear()
    yield
    db.get_supabase.cache_clear()


@pytest.fixture
def create_client(monkeypatch):
    factory = Mock(return_value=object())
    monkeypatch.setattr(supabase, "create_client", factory)
    return factory


def test_loads_root_dotenv_and_reuses_client(tmp_path, create_client):
    (tmp_path / ".env").write_text(
        f'{URL_ENV}=" {URL}/ "\n{KEY_ENV}=" {KEY} "\n', encoding="utf-8"
    )
    first = db.get_supabase()
    assert db.get_supabase() is first is create_client.return_value
    create_client.assert_called_once()
    assert create_client.call_args.args == (URL, KEY)
    options = create_client.call_args.kwargs["options"]
    assert options.persist_session is False
    assert options.auto_refresh_token is False
    assert options.postgrest_client_timeout > 0
    assert options.storage_client_timeout > 0


def test_environment_takes_precedence_over_dotenv(monkeypatch, tmp_path, create_client):
    (tmp_path / ".env").write_text(
        f"{URL_ENV}=https://other.supabase.co\n{KEY_ENV}=other-key\n",
        encoding="utf-8",
    )
    monkeypatch.setenv(URL_ENV, URL)
    monkeypatch.setenv(KEY_ENV, KEY)
    db.get_supabase()
    assert create_client.call_args.args == (URL, KEY)


@pytest.mark.parametrize("missing", [URL_ENV, KEY_ENV])
@pytest.mark.parametrize("value", [None, "", "   "])
def test_missing_config_fails_before_client_creation(monkeypatch, create_client, missing, value):
    monkeypatch.setenv(URL_ENV, URL)
    monkeypatch.setenv(KEY_ENV, KEY)
    if value is None:
        monkeypatch.delenv(missing)
    else:
        monkeypatch.setenv(missing, value)
    with pytest.raises(RuntimeError, match=missing):
        db.get_supabase()
    create_client.assert_not_called()


@pytest.mark.parametrize("url", [
    "http://example.supabase.co",
    "example.supabase.co",
    "https://",
    "https://user:password@example.supabase.co",
    "https://example.supabase.co/rest/v1",
    "https://example.supabase.co?apikey=sensitive",
    "https://example.supabase.co#fragment",
])
def test_invalid_url_is_rejected_without_echoing_value(monkeypatch, create_client, url):
    monkeypatch.setenv(URL_ENV, url)
    monkeypatch.setenv(KEY_ENV, KEY)
    with pytest.raises(RuntimeError) as error:
        db.get_supabase()
    assert URL_ENV in str(error.value)
    assert url not in str(error.value)
    create_client.assert_not_called()


def test_does_not_fall_back_to_privileged_key(monkeypatch, create_client):
    monkeypatch.setenv(URL_ENV, URL)
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "secret-test-key")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "legacy-test-key")
    with pytest.raises(RuntimeError, match=KEY_ENV):
        db.get_supabase()
    create_client.assert_not_called()


def test_failed_initialization_can_be_retried(monkeypatch, create_client):
    monkeypatch.setenv(URL_ENV, URL)
    monkeypatch.setenv(KEY_ENV, KEY)
    client = object()
    create_client.side_effect = [RuntimeError("SDK initialization failed"), client]
    with pytest.raises(RuntimeError, match="SDK initialization failed"):
        db.get_supabase()
    assert db.get_supabase() is client
    assert create_client.call_count == 2
