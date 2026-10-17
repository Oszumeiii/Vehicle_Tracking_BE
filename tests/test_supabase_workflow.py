from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock
from pathlib import Path
import sys

from fastapi import HTTPException
import pytest
from app.core.config import Settings
from app.services.plate_job_service import JobService
from app.api.deps import get_job_service


@pytest.fixture
def service(tmp_path):
    settings = Settings(tmp_path,tmp_path,Path(sys.executable))
    service = JobService(settings)
    service.settings = replace(settings,db_backend='supabase')
    service.repo = Mock()
    service.storage = Mock(bucket='vehicle-frames')
    return service


def prepare(service):
    folder = service.job_dir('a' * 32)
    folder.mkdir(parents=True)
    (folder/'crop.jpg').write_bytes(b'jpeg')
    return [{'crop_id':'00000001','track_id':'1','track_summary':{'status':'unrecognized'},'path':'crop.jpg'}]


def test_upload_failure_cleans_attempted_objects_without_success(service):
    crops = prepare(service)
    service.storage.upload.side_effect = RuntimeError('upload failed')
    with pytest.raises(RuntimeError):
        service.complete('a'*32,5,crops)
    service.repo.succeed.assert_not_called()
    service.storage.remove.assert_called_once_with([f"{'a'*32}/00000001.jpg"])


def test_ambiguous_commit_keeps_files_for_reconciliation(service):
    crops = prepare(service)
    service.repo.succeed.side_effect = RuntimeError('commit acknowledgement lost')
    with pytest.raises(RuntimeError):
        service.complete('a'*32,5,crops)
    service.storage.remove.assert_not_called()
    assert (service.job_dir('a'*32)/'storage-uploads.json').exists()


def test_storage_signing_requires_visible_successful_job(service):
    service.repo.get.return_value = None
    with pytest.raises(HTTPException) as exc:
        service.crop_url('a'*32,'00000001')
    assert exc.value.status_code == 404
    service.storage.signed_url.assert_not_called()


def test_delete_checks_write_access_before_storage_delete(service):
    service.repo.get.return_value = {'status':'succeeded','node_id':'local'}
    service.repo.artifacts.side_effect = PermissionError('Viewer')
    with pytest.raises(PermissionError):
        service.delete('a'*32)
    service.storage.remove.assert_not_called()


def test_api_requires_token_in_supabase_mode(service):
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(jobs=service)),headers={})
    with pytest.raises(HTTPException) as exc:
        get_job_service(request)
    assert exc.value.status_code == 401


def test_api_uses_verified_auth_user_not_token_payload(service, monkeypatch):
    import app.db.supabase as db
    import app.api.deps as deps
    client = Mock()
    client.auth.get_user.return_value = SimpleNamespace(user=SimpleNamespace(id='verified-user'))
    monkeypatch.setattr(db,'get_supabase',lambda:client)
    scoped = Mock()
    from contextlib import nullcontext
    scoped.repo.connection.return_value = nullcontext()
    factory = Mock(return_value=scoped)
    monkeypatch.setattr(deps,'JobService',factory)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(jobs=service)),
                              headers={'Authorization':'Bearer untrusted-token'})
    assert get_job_service(request) is scoped
    client.auth.get_user.assert_called_once_with('untrusted-token')
    factory.assert_called_once_with(service.settings,user_id='verified-user')
