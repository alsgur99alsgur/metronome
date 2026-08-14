import { validateNodeName } from "./nameValidation";

export const pythonTemplate = (name) =>
  `def func_${validateNodeName(name)}(inputs):
    """
    inputs:
        list[pandas.DataFrame]

    return:
        pandas.DataFrame
    """

    if inputs:
        df = inputs[0]
    else:
        df = pd.DataFrame({"value": [1, 2, 3]})

    result = df
    return result
`;
