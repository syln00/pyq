import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../config/database";
import type Post from "./Post";

interface CommentAttributes {
  id: string;
  postId: string | null;
  pageId: string | null;
  authorName: string;
  email: string;
  website?: string;
  replyTo?: string;
  replyToEmail?: string;
  replyToId?: string;
  content: string;
  ip?: string;
  region?: string;
  userId: string | null;
  replyToUserId: string | null;
}

interface CommentCreationAttributes
  extends Optional<CommentAttributes, "id" | "postId" | "pageId" | "replyTo" | "replyToEmail" | "replyToId" | "website" | "ip" | "region" | "userId" | "replyToUserId"> {}

class Comment
  extends Model<CommentAttributes, CommentCreationAttributes>
  implements CommentAttributes
{
  declare id: string;
  declare postId: string | null;
  declare pageId: string | null;
  declare authorName: string;
  declare email: string;
  declare website?: string;
  declare replyTo?: string;
  declare replyToEmail?: string;
  declare replyToId?: string;
  declare content: string;
  declare ip?: string;
  declare region?: string;
  declare userId: string | null;
  declare replyToUserId: string | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
  // Association
  declare post?: Post;
}

Comment.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    postId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "post_id",
      references: {
        model: "posts",
        key: "id",
      },
      onDelete: "CASCADE",
    },
    pageId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "page_id",
    },
    authorName: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      defaultValue: "",
    },
    website: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    replyTo: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    replyToEmail: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    replyToId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    ip: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    region: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    replyToUserId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
  },
  {
    sequelize,
    tableName: "comments",
  }
);

export default Comment;
