"""V3-1：提示词必须由契约语义渲染生成，且与 schema 键集合一致。"""

from __future__ import annotations

from app.model.core import SYSTEM_PROMPT
from app.model.render_prompt import render_system_prompt
from contract.models import FIELD_SEMANTICS, TYPE_KEYS, UNIVERSAL_KEYS


def test_prompt_is_generated_not_hand_written():
    assert SYSTEM_PROMPT == render_system_prompt()


def test_prompt_covers_all_closed_keys():
    for ct, extra in TYPE_KEYS.items():
        for key in UNIVERSAL_KEYS | extra:
            assert key in SYSTEM_PROMPT, f"{ct}.{key} 未进提示词"


def test_prompt_covers_critical_rules():
    for fragment in ("不得自创键", "24:00", "不要自行补年份或时区", "unresolved", "missing", "confirmed"):
        assert fragment in SYSTEM_PROMPT


def test_semantics_keys_match_contract_keys():
    for ct, extra in TYPE_KEYS.items():
        assert set(FIELD_SEMANTICS[ct]) == UNIVERSAL_KEYS | extra
