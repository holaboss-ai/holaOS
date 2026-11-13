"""BFCL v4 single-turn grader: a stdlib port of the Python branch of BFCL's ast_checker.py.

Ported from ShishirPatil/gorilla@6ea57973c7a6097fd7c5915698c54c17c5b1b6c8,
berkeley-function-call-leaderboard/bfcl_eval/eval_checker/ast_eval/ast_checker.py (Apache-2.0), for a
function-calling model whose tool names had dots replaced with underscores. Comparisons deliberately keep
upstream's Python semantics (`type(x) == T`, `x in list`), so the verdict matches the leaderboard's.
"""

import re

from .common import FORMAT_ERROR, PASS, WRONG, verdict

PYTHON_TYPE_MAPPING = {
    "string": str,
    "integer": int,
    "float": float,
    "boolean": bool,
    "array": list,
    "tuple": list,
    "dict": dict,
    "any": str,
}
PYTHON_NESTED_TYPE_CHECK_LIST = ("array", "tuple")


def grade(item, resp):
    calls = resp["tool_calls"]
    if item["category"] == "irrelevance" or item["answer"].get("no_call"):
        if not calls:
            return verdict(PASS, "made no tool call, as none of the tools fit")
        return verdict(WRONG, f"called {calls[0]['name'] or 'a tool'} although none of the tools fit the request")
    if not calls:
        return verdict(WRONG, "answered in text without calling a tool")
    for call in calls:
        if call["arguments"] is None:
            return verdict(FORMAT_ERROR, f"arguments of the {call['name'] or 'unnamed'} call were not a JSON object")
    model_output = [{call["name"]: call["arguments"]} for call in calls]
    answer = item["answer"]
    result = ast_checker(answer["functions"], model_output, answer["ground_truth"], item["category"])
    if result["valid"]:
        return verdict(PASS, "called the expected function(s) with accepted arguments")
    return verdict(WRONG, result["detail"])


def ast_checker(func_description, model_output, possible_answer, test_category):
    if "parallel" in test_category:
        return parallel_function_checker_no_order(func_description, model_output, possible_answer)
    if "multiple" in test_category:
        return multiple_function_checker(func_description, model_output, possible_answer)
    if len(model_output) != 1:
        return _fail(f"made {_calls(len(model_output))}, expected 1")
    return simple_function_checker(func_description[0], model_output[0], possible_answer[0])


def _fail(detail):
    return {"valid": False, "detail": detail}


_OK = {"valid": True, "detail": ""}


def _calls(n):
    return "1 call" if n == 1 else f"{n} calls"


def _short(value):
    text = repr(value)
    return text if len(text) <= 80 else text[:77] + "..."


def find_description(func_descriptions, name):
    for func_description in func_descriptions:
        if func_description["name"] == name:
            return func_description
    return None


def get_possible_answer_type(possible_answer):
    for answer in possible_answer:
        if answer != "":
            return type(answer)
    return None


def convert_func_name(function_name):
    return re.sub(r"\.", "_", function_name)


def type_checker(param, value, possible_answer, expected_type_description, expected_type_converted,
                 nested_type_converted):
    is_variable = False
    possible_answer_type = get_possible_answer_type(possible_answer)
    if possible_answer_type is not None and possible_answer_type != expected_type_converted:
        is_variable = True

    nested_failed = False
    if type(value) == expected_type_converted:
        if nested_type_converted is None:
            return {"valid": True, "is_variable": is_variable}
        for possible_answer_item in possible_answer:
            flag = True
            if type(possible_answer_item) == list:
                for value_item in value:
                    inner = type_checker(param, value_item, possible_answer_item, str(nested_type_converted),
                                         nested_type_converted, None)
                    if not inner["valid"]:
                        flag = False
                        break
            if flag:
                return {"valid": True, "is_variable": is_variable}
        nested_failed = True

    if possible_answer_type is not None and type(value) == possible_answer_type:
        if nested_failed:
            return {"valid": False, "is_variable": True, "detail": f"{param} had items of the wrong type"}
        return {"valid": True, "is_variable": True}

    if nested_failed:
        return {"valid": False, "is_variable": False, "detail": f"{param} had items of the wrong type"}
    return {"valid": False, "is_variable": False,
            "detail": f"{param} was a {_type_name(value)}, expected {expected_type_description}"}


def _type_name(value):
    return {str: "string", int: "integer", float: "float", bool: "boolean", list: "list", dict: "object",
            type(None): "null"}.get(type(value), type(value).__name__)


def standardize_string(input_string):
    return re.sub(r"[ \,\.\/\-\_\*\^]", "", input_string).lower().replace("'", '"')


def string_checker(param, model_output, possible_answer):
    standardized = [standardize_string(a) for a in possible_answer if type(a) == str]
    if standardize_string(model_output) not in standardized:
        expected = [a for a in possible_answer if a != ""]
        return _fail(f"{param} was {_short(model_output)}, expected {_short(expected[0] if len(expected) == 1 else expected)}")
    return _OK


def list_checker(param, model_output, possible_answer):
    standardized_output = [standardize_string(v) if type(v) == str else v for v in model_output]
    standardized_answers = [
        [standardize_string(v) if type(v) == str else v for v in answer] for answer in possible_answer
    ]
    if standardized_output not in standardized_answers:
        return _fail(f"{param} was {_short(model_output)}, not an accepted list")
    return _OK


def dict_checker(param, model_output, possible_answers):
    result = _fail(f"{param} did not match any accepted object")
    for possible_answer in possible_answers:
        if possible_answer == "":
            continue
        result = _fail(f"{param} did not match any accepted object")
        flag = True
        for key, value in model_output.items():
            if key not in possible_answer:
                result = _fail(f"{param} had an unexpected key {key!r}")
                flag = False
                break
            standardize_value = standardize_string(value) if type(value) == str else value
            standardized = [standardize_string(a) if type(a) == str else a for a in possible_answer[key]]
            if standardize_value not in standardized:
                result = _fail(f"{param}.{key} was {_short(value)}, not an accepted value")
                flag = False
                break
        for key, value in possible_answer.items():
            if key not in model_output and "" not in value:
                result = _fail(f"{param} was missing the key {key!r}")
                flag = False
                break
        if flag:
            return _OK
    return result


def list_dict_checker(param, model_output, possible_answers):
    result = _fail(f"{param} did not match any accepted list of objects")
    for answer in possible_answers:
        flag = True
        if len(model_output) != len(answer):
            result = _fail(f"{param} had {len(model_output)} objects, expected {len(answer)}")
            continue
        for index in range(len(model_output)):
            result = dict_checker(param, model_output[index], [answer[index]])
            if not result["valid"]:
                flag = False
                break
        if flag:
            return _OK
    return result


def simple_function_checker(func_description, model_output, possible_answer):
    possible_answer = list(possible_answer.values())[0]
    func_name = convert_func_name(func_description["name"])
    param_details = func_description["properties"]
    required_params = func_description["required"]

    if func_name not in model_output:
        called = ", ".join(model_output) or "nothing"
        return _fail(f"called {called}, expected {func_name}")
    model_params = model_output[func_name]

    for param in required_params:
        if param not in model_params:
            return _fail(f"{func_name} was missing the required argument {param}")

    for param, value in model_params.items():
        if param not in param_details or param not in possible_answer:
            return _fail(f"{func_name} got an unexpected argument {param}")
        expected_type_description = param_details[param]["type"]
        expected_type_converted = PYTHON_TYPE_MAPPING[expected_type_description]
        nested_type_converted = None
        if expected_type_description in PYTHON_NESTED_TYPE_CHECK_LIST:
            nested_type_converted = PYTHON_TYPE_MAPPING[param_details[param]["items"]["type"]]

        if expected_type_description == "float" and type(value) == int:
            value = float(value)

        checked = type_checker(param, value, possible_answer[param], expected_type_description,
                               expected_type_converted, nested_type_converted)
        if not checked["valid"]:
            return _fail(f"{func_name}: {checked['detail']}")

        if not checked["is_variable"]:
            if expected_type_converted == dict:
                result = dict_checker(param, value, possible_answer[param])
            elif expected_type_converted == list and nested_type_converted == dict:
                result = list_dict_checker(param, value, possible_answer[param])
            elif expected_type_converted == str:
                result = string_checker(param, value, possible_answer[param])
            elif expected_type_converted == list:
                result = list_checker(param, value, possible_answer[param])
            else:
                result = None
            if result is not None:
                if not result["valid"]:
                    return _fail(f"{func_name}: {result['detail']}")
                continue

        if value not in possible_answer[param]:
            expected = [a for a in possible_answer[param] if a != ""]
            return _fail(f"{func_name}: {param} was {_short(value)}, expected "
                         f"{_short(expected[0] if len(expected) == 1 else expected)}")

    for param in possible_answer:
        if param not in model_params and "" not in possible_answer[param]:
            return _fail(f"{func_name} was missing the argument {param}")
    return _OK


def parallel_function_checker_no_order(func_descriptions, model_output, possible_answers):
    if len(model_output) != len(possible_answers):
        return _fail(f"made {_calls(len(model_output))}, expected {len(possible_answers)}")
    matched_indices = []
    for possible_answer in possible_answers:
        func_name_expected = list(possible_answer.keys())[0]
        func_description = find_description(func_descriptions, func_name_expected)
        result = None
        for index in range(len(model_output)):
            if index in matched_indices:
                continue
            result = simple_function_checker(func_description, model_output[index], possible_answer)
            if result["valid"]:
                matched_indices.append(index)
                break
        if result is None or not result["valid"]:
            reason = result["detail"] if result else "no call left to match"
            return _fail(f"no call matched the expected {convert_func_name(func_name_expected)} ({reason})")
    return _OK


def multiple_function_checker(func_descriptions, model_output, possible_answers):
    if len(model_output) != len(possible_answers):
        return _fail(f"made {_calls(len(model_output))}, expected {len(possible_answers)}")
    func_name_expected = list(possible_answers[0].keys())[0]
    func_description = find_description(func_descriptions, func_name_expected)
    return simple_function_checker(func_description, model_output[0], possible_answers[0])
