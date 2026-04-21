import jwt from "jsonwebtoken";

const generateAccessToken = ({ _id, firstName, name, email, role, isPremium }) => {
  return jwt.sign(
    { _id, name: firstName ?? name, email, role, isPremium },
    process.env.ACCESS_TOKEN_SECRET,
    {
    expiresIn: "1h",
    },
  );
};

const generateRefreshToken = (_id) => {
  return jwt.sign({ _id }, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: "7d",
  });
};

export { generateAccessToken, generateRefreshToken };