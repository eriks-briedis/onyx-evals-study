"""onyx-evals patch: answer a dated question from the document versions in force on that date.

A corpus of Authorised Versions holds several versions of the same Act. Onyx's time-scope step
reads "It is 1 October 2025. My landlord ..." either as no time at all (every version is
searched and the answer mixes them) or as "documents updated on 1 October 2025" (nothing
matches). This module gives the search tool two replacements:

  decide_as_at_filter(history, llm)
      One LLM call that returns the date the question should be answered as at, as a
      TimeFilter whose window is that single day. When the conversation states no such date
      the question is answered as at today (a user who gives no date means now), so every
      instrument's current version is searched. Only a failed LLM call falls back to Onyx's
      own decide_time_filter.

  apply_time_filter(time_filter, filters)
      Restricts the search to, per instrument, the version in force on the window's last day
      (its first day when the window is open toward now), using the in-force labels the
      documents carry as tags, set in .onyx_metadata.json when the corpus is seeded:
          instrument     one value per family of versions      rta-1997
          version_id     one value per document                rta-1997-v110
          in_force_from  YYYY-MM-DD
          in_force_to    YYYY-MM-DD; absent while the version is still in force
      When the searched documents carry no labels, or the caller already filters on tags,
      the window is applied as Onyx does (updated_at within the window).

Installed by onyx-patches/version-filter/apply.sh into onyx/secondary_llm_flows/ of the
running api_server container, with three one-line changes to
onyx/tools/tool_implementations/search/search_tool.py. Lost when the container is recreated.
"""

from __future__ import annotations

import os
import re
from datetime import date, datetime, time, timezone
from pathlib import Path

from sqlalchemy import text

from onyx.configs.constants import MessageType
from onyx.context.search.models import BaseFilters, Tag
from onyx.db.engine.sql_engine import get_session_with_current_tenant
from onyx.llm.interfaces import LLM, GenerationContext
from onyx.llm.models import (
    GenerationOptions,
    GenerationRequest,
    Message,
    ReasoningEffort,
    UserMessage,
)
from onyx.secondary_llm_flows.time_filter import (
    MAX_TIME_FILTER_USER_TURNS,
    DocumentTimeField,
    TimeFilter,
    decide_time_filter,
)
from onyx.tools.models import ChatMinimalTextMessage
from onyx.tracing.flows import LLMFlow
from onyx.utils.logger import setup_logger

logger = setup_logger()

LABEL_KEYS = ("instrument", "version_id", "in_force_from", "in_force_to")

AS_AT_PROMPT = """
You decide the date a question about rules, law or policy should be answered AS AT, so that \
the search can pick the version of each document that was in force on that date.

Return the as-at date when the conversation states the date the user's situation is to be \
judged at, in the latest message or in an earlier turn it continues: either the date it is \
being asked on ("It is 1 October 2025", "Today is 3 March 2024", "as at June 2023"), or a past \
event the user asks about as it stood at the time ("this happened on 12 May 2020, was that \
allowed?", "back in November 2019 my landlord gave me a notice; was it valid?"). A month \
without a day means its first day. A relative phrase ("as at last month") resolves against \
today.

A date that only marks a step in a situation the user is asking about NOW is NOT the as-at \
date: "I sent the form three weeks ago, can they refuse?", "the lease started in May", "the \
notice arrived on Monday" ask about the rules as they stand today, so return None. When the \
conversation gives no as-at date, return None: do NOT infer a date from the topic, and a year \
or date that is part of a document's name ("the 2021 Regulations", "the 1997 Act") is NOT the \
as-at date.

## Conversation history

{conversation_history}

## Current date

Today is {current_day_time_str}.

## Latest message

{last_user_query}

## Output format

Output ONLY "as_at (YYYY-MM-DD)" or "as_at (None)". No other text.
"""

_AS_AT_RE = re.compile(r"as_at\s*\(\s*(\d{4}-\d{2}-\d{2}|none)\s*\)", re.IGNORECASE)


def _parse_as_at(content: str | None) -> date | None:
    if not content:
        return None
    match = _AS_AT_RE.search(content)
    if match is None:
        logger.warning("As-at decision was not an as_at(...) answer: %s", content)
        return None
    token = match.group(1)
    if token.lower() == "none":
        return None
    try:
        return datetime.strptime(token, "%Y-%m-%d").date()
    except ValueError:
        return None


def decide_as_at_filter(
    history: list[ChatMinimalTextMessage],
    llm: LLM,
) -> TimeFilter | None:
    """The date the conversation says the question is asked as at, as a one-day
    TimeFilter; today when no such date is stated; Onyx's own time filter only when the
    as-at call itself fails."""
    user_turns = [
        msg.message.strip()
        for msg in history
        if msg.message_type == MessageType.USER and msg.message.strip()
    ]
    if not user_turns:
        return None
    user_turns = user_turns[-MAX_TIME_FILTER_USER_TURNS:]
    last_user_query = user_turns[-1]
    prior_turns = user_turns[:-1]
    conversation_history = (
        "\n".join(prior_turns)
        if prior_turns
        else "N/A, this is the first message in the conversation."
    )
    now = datetime.now(timezone.utc)
    prompt = AS_AT_PROMPT.format(
        current_day_time_str=now.strftime("%A %B %d, %Y"),
        conversation_history=conversation_history,
        last_user_query=last_user_query,
    )
    messages: list[Message] = [UserMessage(content=prompt)]
    as_at: date | None = None
    try:
        response = llm.invoke(
            GenerationRequest(
                messages=messages,
                options=GenerationOptions(reasoning_effort=ReasoningEffort.OFF),
            ),
            context=GenerationContext(flow=LLMFlow.TIME_FILTER_EXTRACTION),
        )
        as_at = _parse_as_at(response.text)
    except Exception:
        logger.exception("As-at decision failed; falling back to Onyx's time filter")
        return decide_time_filter(history, llm)

    if as_at is None:
        # No date stated means now: the user wants the rules as they stand today.
        as_at = now.date()
        logger.info("Internal search - as-at date: none stated; using today (%s)", as_at.isoformat())
    else:
        logger.info("Internal search - as-at date: %s", as_at.isoformat())
    return TimeFilter(
        field=DocumentTimeField.UPDATED_AT,
        start=datetime.combine(as_at, time.min, tzinfo=timezone.utc),
        end=datetime.combine(as_at, time.max, tzinfo=timezone.utc),
    )


_LABELS_SQL = """
select d.id, t.tag_key, t.tag_value
from document d
join document__tag dt on dt.document_id = d.id
join tag t on t.id = dt.tag_id
where t.tag_key = any(:keys)
"""

_IN_SETS_SQL = """
and d.id in (
  select dcc.id
  from document_by_connector_credential_pair dcc
  join connector_credential_pair cc
    on cc.connector_id = dcc.connector_id and cc.credential_id = dcc.credential_id
  join document_set__connector_credential_pair dsc on dsc.connector_credential_pair_id = cc.id
  join document_set ds on ds.id = dsc.document_set_id
  where ds.name = any(:sets)
)
"""


def labelled_versions(document_sets: list[str] | None) -> dict[str, dict[str, str]]:
    """The in-force labels of every searched document that has any, by document id."""
    sql = _LABELS_SQL + (_IN_SETS_SQL if document_sets else "")
    params: dict[str, list[str]] = {"keys": list(LABEL_KEYS)}
    if document_sets:
        params["sets"] = list(document_sets)
    with get_session_with_current_tenant() as db_session:
        rows = db_session.execute(text(sql), params).all()
    docs: dict[str, dict[str, str]] = {}
    for doc_id, key, value in rows:
        docs.setdefault(doc_id, {})[key] = value
    return docs


def _day(value: str | None) -> date | None:
    try:
        return date.fromisoformat(value) if value else None
    except ValueError:
        return None


def versions_in_force(as_at: date, document_sets: list[str] | None) -> list[str] | None:
    """The version_id of each instrument's version in force on `as_at`, or None when the
    searched documents carry no in-force labels."""
    docs = labelled_versions(document_sets)
    if not docs:
        return None
    picks: dict[str, tuple[date, str]] = {}
    for labels in docs.values():
        instrument = labels.get("instrument")
        version_id = labels.get("version_id")
        start = _day(labels.get("in_force_from"))
        end = _day(labels.get("in_force_to"))
        if not (instrument and version_id and start):
            continue
        if start <= as_at and (end is None or as_at <= end):
            previous = picks.get(instrument)
            if previous is None or start > previous[0]:
                picks[instrument] = (start, version_id)
    return sorted(version_id for _, version_id in picks.values())


RULE_FILE = Path(__file__).with_suffix(".rule")  # written by apply.sh rule <name>


def version_rule() -> str:
    """Which selection rule picks the versions: 'labels' (the in-force tags, the default) or
    'latest-dated' (file name and file date only, what a deployment without labels could run)."""
    try:
        rule = RULE_FILE.read_text().strip()
    except OSError:
        rule = ""
    return rule or os.environ.get("VERSION_RULE", "labels")


_DATED_SQL = """
select d.id, d.semantic_id, d.doc_updated_at, t.tag_value
from document d
left join document__tag dt on dt.document_id = d.id
left join tag t on t.id = dt.tag_id and t.tag_key = 'version_id'
where d.doc_updated_at is not null
"""

# Version numbers and dates in a file name: "v115", "_v3", "Version No. 115", "2026-10-13".
_VERSION_TOKENS = re.compile(r"(?i)(?<![a-z0-9])(?:v(?:ersion)?\.?\s*(?:no\.?\s*)?\d+(?:\.\d+)*|\d{4}-\d{2}-\d{2})(?![a-z0-9])")


def title_family(name: str) -> str:
    """The file name with its version and date tokens and extension removed: the documents
    that are versions of one title share it ("rta-1997-v115-2026-10-13.pdf" -> "rta-1997")."""
    base = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", name)
    base = _VERSION_TOKENS.sub(" ", base)
    base = re.sub(r"[()\[\]{}]", " ", base)
    return re.sub(r"[\s_\-]+", "-", base).strip("-").lower()


def latest_dated_versions(as_at: date, document_sets: list[str] | None) -> list[str] | None:
    """The label-free rule: for each title family, the document with the latest file date
    (doc_updated_at) on or before `as_at`. Reads only the file name and the file date. The
    filter still needs a per-document key, and Onyx's filter model has no document-id filter,
    so the key is the document's version_id tag (a deployment would set one tag per file from
    its name). None when no searched document has a file date or a picked one has no key."""
    sql = _DATED_SQL + (_IN_SETS_SQL if document_sets else "")
    params: dict[str, list[str]] = {"sets": list(document_sets)} if document_sets else {}
    with get_session_with_current_tenant() as db_session:
        rows = db_session.execute(text(sql), params).all()
    docs: dict[str, tuple[str, date, str | None]] = {}
    for doc_id, name, updated, key in rows:
        previous = docs.get(doc_id)
        docs[doc_id] = (name, updated.date(), key or (previous[2] if previous else None))
    if not docs:
        return None
    picks: dict[str, tuple[date, str | None, str]] = {}
    for name, when, key in docs.values():
        if when > as_at:
            continue
        family = title_family(name)
        previous = picks.get(family)
        if previous is None or when > previous[0]:
            picks[family] = (when, key, name)
    unkeyed = [name for _, key, name in picks.values() if not key]
    if unkeyed:
        logger.warning("Internal search - version filter: picked documents without a key: %s", unkeyed)
        return None
    logger.info(
        "Internal search - version rule latest-dated: %s",
        "; ".join(f"{family} -> {name} ({when.isoformat()})" for family, (when, _, name) in sorted(picks.items())),
    )
    return sorted(key for _, key, _ in picks.values() if key)


def apply_time_filter(time_filter: TimeFilter, filters: BaseFilters) -> BaseFilters:
    """Turn the inferred window into 'the versions in force on its last day' for labelled
    corpora; Onyx's own updated_at window otherwise."""
    bound = time_filter.end or time_filter.start
    if bound is None or filters.tags:
        return time_filter.apply_to(filters)
    as_at = bound.date()
    rule = version_rule()
    if rule == "latest-dated":
        picks = latest_dated_versions(as_at, filters.document_set)
    else:
        picks = versions_in_force(as_at, filters.document_set)
    if picks is None:
        return time_filter.apply_to(filters)
    if not picks:
        logger.info(
            "Internal search - version filter: no labelled version in force on %s; searching all",
            as_at.isoformat(),
        )
        return filters
    logger.info(
        "Internal search - version filter: in force on %s: %s",
        as_at.isoformat(),
        ", ".join(picks),
    )
    return filters.model_copy(
        update={"tags": [Tag(tag_key="version_id", tag_value=v) for v in picks]}
    )
